//! Voice dictation: the microphone, a local Whisper model, and the text it
//! hears. Nothing leaves the machine but the one-off model download.
//!
//! The model is opt-in. The app ships whisper.cpp but no weights: Settings
//! downloads one of `MODELS` into the app's local data directory on request,
//! checked against its SHA-256, and removes it again on request. Until then
//! dictation is off and costs nothing but the few megabytes of code.
//!
//! A dictation is two calls. `voice_start` opens the default input device on a
//! thread of its own -- cpal's stream is not `Send` everywhere -- and starts
//! loading the model beside it, so the load overlaps the talking.
//! `voice_stop` ends the recording and resolves to the transcript, which the
//! page types wherever the user was. The loaded model stays in memory for
//! `IDLE` after its last use, then goes: turbo holds about a gigabyte.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Once};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// `voice://download`, to every window: the Settings rows and any editor.
const DOWNLOAD: &str = "voice://download";
/// `voice://level`, to the window recording: the meter in its indicator.
const LEVEL: &str = "voice://level";

/// How long a loaded model outlives its last dictation.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// Longer than anyone dictates a prompt; past it the rest is dropped rather
/// than held -- five minutes at 48 kHz is already 55 MB of samples.
const MAX_RECORDING: Duration = Duration::from_secs(5 * 60);
/// What Whisper takes, and what everything is resampled to.
const RATE: u32 = 16_000;

pub struct Model {
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// An `.en` model: told the language rather than left to detect it.
    pub english_only: bool,
}

/// The models Settings offers, from whisper.cpp's own repository. Sizes and
/// hashes are the Hugging Face LFS objects', so a truncated or substituted
/// file is caught before it is ever loaded.
pub const MODELS: &[Model] = &[
    Model {
        id: "large-v3-turbo-q5_0",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        english_only: false,
    },
    Model {
        id: "small.en-q5_1",
        file: "ggml-small.en-q5_1.bin",
        bytes: 190_098_681,
        sha256: "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30",
        english_only: true,
    },
];

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

fn model(id: &str) -> Result<&'static Model, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown dictation model: {id}"))
}

/// Not `~/.aditor` with the settings: that is a folder people back up and
/// carry, and half a gigabyte of weights is neither.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| format!("no data directory for the models: {e}"))
}

#[derive(Clone, Default)]
pub struct VoiceState(Arc<Inner>);

#[derive(Default)]
struct Inner {
    download: Mutex<Option<Download>>,
    recording: Mutex<Option<Recording>>,
    whisper: Mutex<Option<Loaded>>,
}

struct Download {
    id: &'static str,
    received: Arc<Mutex<u64>>,
    cancel: Arc<AtomicBool>,
}

struct Loaded {
    id: &'static str,
    ctx: WhisperContext,
    used: Instant,
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    bytes: u64,
    downloaded: bool,
    /// Bytes so far, while this one is downloading.
    receiving: Option<u64>,
}

/// Every model Settings offers, with what is on disk and what is coming.
#[tauri::command]
pub async fn voice_models(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let (busy, received) = match &*state.0.download.lock().unwrap() {
        Some(d) => (Some(d.id), *d.received.lock().unwrap()),
        None => (None, 0),
    };
    Ok(MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            bytes: m.bytes,
            downloaded: dir.join(m.file).is_file(),
            receiving: (busy == Some(m.id)).then_some(received),
        })
        .collect())
}

/// Start downloading `id`; progress and the outcome arrive as
/// `voice://download` events. One download at a time.
#[tauri::command]
pub fn voice_download(
    app: AppHandle,
    state: State<'_, VoiceState>,
    id: String,
) -> Result<(), String> {
    let m = model(&id)?;
    let dir = models_dir(&app)?;
    let mut slot = state.0.download.lock().unwrap();
    if let Some(d) = &*slot {
        return Err(format!("{} is already downloading.", d.id));
    }
    let received = Arc::new(Mutex::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(Download {
        id: m.id,
        received: received.clone(),
        cancel: cancel.clone(),
    });
    drop(slot);

    let inner = state.0.clone();
    thread::spawn(move || {
        let outcome = fetch(&app, m, &dir, &received, &cancel);
        *inner.download.lock().unwrap() = None;
        let event = match outcome {
            Ok(()) => json!({ "id": m.id, "state": "done" }),
            Err(_) if cancel.load(Ordering::Relaxed) => json!({ "id": m.id, "state": "cancelled" }),
            Err(e) => json!({ "id": m.id, "state": "error", "error": e }),
        };
        let _ = app.emit(DOWNLOAD, event);
    });
    Ok(())
}

#[tauri::command]
pub fn voice_download_cancel(state: State<'_, VoiceState>) {
    if let Some(d) = &*state.0.download.lock().unwrap() {
        d.cancel.store(true, Ordering::Relaxed);
    }
}

/// Into `<file>.part`, renamed only once size and hash check out -- so a model
/// file that exists is a whole one, and that is all `downloaded` looks at.
fn fetch(
    app: &AppHandle,
    m: &Model,
    dir: &Path,
    received: &Mutex<u64>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let part = dir.join(format!("{}.part", m.file));
    let result = (|| {
        // No overall timeout: half a gigabyte takes as long as it takes. A
        // connection that never answers still gives up.
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .build()
            .new_agent();
        let resp = agent
            .get(&format!("{BASE_URL}/{}", m.file))
            .call()
            .map_err(|e| format!("could not download the model: {e}"))?;
        let mut body = resp.into_body().into_reader();
        let mut out = fs::File::create(&part)
            .map_err(|e| format!("could not write {}: {e}", part.display()))?;
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        let mut told = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            let n = body
                .read(&mut buf)
                .map_err(|e| format!("the download broke off: {e}"))?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n])
                .map_err(|e| format!("could not write the model: {e}"))?;
            total += n as u64;
            *received.lock().unwrap() = total;
            if told.elapsed() >= Duration::from_millis(150) {
                told = Instant::now();
                let _ = app.emit(
                    DOWNLOAD,
                    json!({ "id": m.id, "state": "progress", "received": total, "total": m.bytes }),
                );
            }
        }
        out.sync_all()
            .map_err(|e| format!("could not write the model: {e}"))?;
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if total != m.bytes || digest != m.sha256 {
            return Err("the downloaded model is not the expected file; try again.".to_string());
        }
        fs::rename(&part, dir.join(m.file)).map_err(|e| format!("could not keep the model: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

/// Delete a downloaded model, unloading it first if it is the one in memory.
#[tauri::command]
pub async fn voice_remove(
    app: AppHandle,
    state: State<'_, VoiceState>,
    id: String,
) -> Result<(), String> {
    let m = model(&id)?;
    let path = models_dir(&app)?.join(m.file);
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut loaded = inner.whisper.lock().unwrap();
        if loaded.as_ref().is_some_and(|l| l.id == m.id) {
            *loaded = None;
        }
        drop(loaded);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove {}: {e}", path.display())),
        }
    })
    .await
    .map_err(|e| format!("the removal did not finish: {e}"))?
}

struct Recording {
    model: &'static Model,
    stop: mpsc::Sender<()>,
    thread: JoinHandle<Result<Captured, String>>,
}

struct Captured {
    /// Mono, at `rate`.
    samples: Vec<f32>,
    rate: u32,
}

/// Open the microphone and start listening, for `model` to transcribe.
///
/// Resolves once the stream is running, so a missing or refused device is an
/// error here rather than an empty transcript later.
#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, VoiceState>,
    model: String,
) -> Result<(), String> {
    let m = self::model(&model)?;
    let path = models_dir(&app)?.join(m.file);
    if !path.is_file() {
        return Err("That dictation model is not downloaded. Get it in Settings → General.".into());
    }
    let inner = state.0.clone();
    if inner.recording.lock().unwrap().is_some() {
        return Err("Already listening.".into());
    }

    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (stop, stop_rx) = mpsc::channel();
    let label = window.label().to_string();
    let handle = thread::spawn(move || record(window, label, started_tx, stop_rx));
    let started = tauri::async_runtime::spawn_blocking(move || started_rx.recv())
        .await
        .map_err(|e| e.to_string())?;
    match started {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = handle.join();
            return Err(e);
        }
        Err(_) => return Err("The microphone thread stopped before it started.".into()),
    }
    *inner.recording.lock().unwrap() = Some(Recording {
        model: m,
        stop,
        thread: handle,
    });

    // Load while the user talks; `voice_stop` waits on the same lock.
    thread::spawn(move || {
        let _ = with_model(&inner, m, &path, |_| Ok(()));
    });
    Ok(())
}

/// Stop listening and resolve to what was said. `prompt` is vocabulary to
/// steer Whisper toward -- the project's file names and identifiers -- and
/// `language` an ISO code or "auto".
#[tauri::command]
pub async fn voice_stop(
    app: AppHandle,
    state: State<'_, VoiceState>,
    prompt: String,
    language: String,
) -> Result<String, String> {
    let rec = state
        .0
        .recording
        .lock()
        .unwrap()
        .take()
        .ok_or("Not listening.")?;
    let path = models_dir(&app)?.join(rec.model.file);
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = rec.stop.send(());
        let captured = rec
            .thread
            .join()
            .map_err(|_| "The microphone thread failed.".to_string())??;
        let Some(audio) = prepare(captured)? else {
            return Ok(String::new());
        };
        with_model(&inner, rec.model, &path, |ctx| {
            transcribe(ctx, rec.model, &audio, &prompt, &language)
        })
    })
    .await
    .map_err(|e| format!("the transcription did not finish: {e}"))?
}

/// Stop listening and throw the recording away.
#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) {
    if let Some(rec) = state.0.recording.lock().unwrap().take() {
        let _ = rec.stop.send(());
    }
}

/// The recording thread: owns the stream from open to close.
fn record(
    window: WebviewWindow,
    label: String,
    started: mpsc::SyncSender<Result<(), String>>,
    stop: mpsc::Receiver<()>,
) -> Result<Captured, String> {
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let failed = Arc::new(Mutex::new(None::<String>));
    let opened = (|| {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("No microphone found.")?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Could not read the microphone's format: {e}"))?;
        let rate = config.sample_rate();
        let stream = match config.sample_format() {
            SampleFormat::F32 => open::<f32>(&device, &config, &samples, &failed),
            SampleFormat::I16 => open::<i16>(&device, &config, &samples, &failed),
            SampleFormat::I32 => open::<i32>(&device, &config, &samples, &failed),
            SampleFormat::U16 => open::<u16>(&device, &config, &samples, &failed),
            SampleFormat::I8 => open::<i8>(&device, &config, &samples, &failed),
            SampleFormat::U8 => open::<u8>(&device, &config, &samples, &failed),
            other => Err(format!(
                "The microphone's sample format ({other}) is not supported."
            )),
        }?;
        stream
            .play()
            .map_err(|e| format!("Could not start the microphone: {e}"))?;
        Ok::<_, String>((stream, rate))
    })();
    let (stream, rate) = match opened {
        Ok(s) => s,
        Err(e) => {
            let _ = started.send(Err(e.clone()));
            return Err(e);
        }
    };
    let _ = started.send(Ok(()));

    // The meter: the loudness of what came in since the last tick.
    let mut seen = 0;
    while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(Duration::from_millis(80)) {
        let level = {
            let s = samples.lock().unwrap();
            let fresh = &s[seen.min(s.len())..];
            seen = s.len();
            peak(fresh)
        };
        let _ = window.emit_to(label.as_str(), LEVEL, level);
    }
    drop(stream);

    if let Some(e) = failed.lock().unwrap().take() {
        return Err(format!("The microphone stopped: {e}"));
    }
    let samples = std::mem::take(&mut *samples.lock().unwrap());
    Ok(Captured { samples, rate })
}

/// An input stream that downmixes to mono into `samples`.
fn open<T>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    samples: &Arc<Mutex<Vec<f32>>>,
    failed: &Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels().max(1) as usize;
    let cap = (config.sample_rate() as u64 * MAX_RECORDING.as_secs()) as usize;
    let into = samples.clone();
    let failed = failed.clone();
    device
        .build_input_stream::<T, _, _>(
            config.config(),
            move |data: &[T], _| {
                let mut out = into.lock().unwrap();
                for frame in data.chunks(channels) {
                    if out.len() >= cap {
                        return;
                    }
                    let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                    out.push(sum / frame.len() as f32);
                }
            },
            move |e| {
                failed.lock().unwrap().get_or_insert_with(|| e.to_string());
            },
            None,
        )
        .map_err(|e| format!("Could not open the microphone: {e}"))
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// 16 kHz mono with the silence trimmed off both ends, or `None` when there
/// is nothing worth handing Whisper -- which, given silence, invents a "Thank
/// you." rather than returning nothing.
fn prepare(c: Captured) -> Result<Option<Vec<f32>>, String> {
    let loudest = peak(&c.samples);
    if !c.samples.is_empty() && loudest == 0.0 {
        // Exact zeros are not a quiet room: that is what macOS delivers when
        // it has refused the microphone.
        return Err(MIC_REFUSED.into());
    }
    let audio = resample(&c.samples, c.rate);
    let Some(audio) = trim(&audio) else {
        return Ok(None);
    };
    // Whisper declines anything under a second; pad short words out to it.
    let mut audio = audio.to_vec();
    let min = RATE as usize * 5 / 4;
    if audio.len() < min {
        audio.resize(min, 0.0);
    }
    Ok(Some(audio))
}

#[cfg(target_os = "macos")]
const MIC_REFUSED: &str =
    "The microphone gave only silence. Allow Aditor in System Settings → Privacy & Security → Microphone.";
#[cfg(not(target_os = "macos"))]
const MIC_REFUSED: &str = "The microphone gave only silence. Check that it is not muted.";

/// Box-filter, then linear interpolation. Crude next to a proper polyphase
/// resampler, but Whisper hears speech through far worse microphones.
fn resample(input: &[f32], from: u32) -> Vec<f32> {
    if from == RATE || input.is_empty() {
        return input.to_vec();
    }
    let width = (from / RATE).max(1) as usize;
    let smoothed: Vec<f32> = if width > 1 {
        let mut acc = 0.0;
        let mut out = Vec::with_capacity(input.len());
        for (i, s) in input.iter().enumerate() {
            acc += s;
            if i >= width {
                acc -= input[i - width];
            }
            out.push(acc / width.min(i + 1) as f32);
        }
        out
    } else {
        input.to_vec()
    };
    let step = from as f64 / RATE as f64;
    let len = (input.len() as f64 / step) as usize;
    (0..len)
        .map(|i| {
            let at = i as f64 * step;
            let j = at as usize;
            let frac = (at - j as f64) as f32;
            let a = smoothed[j];
            let b = *smoothed.get(j + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

/// The span between the first and last 20 ms frames with speech in them,
/// plus a little either side so the first and last syllables survive.
fn trim(audio: &[f32]) -> Option<&[f32]> {
    const FRAME: usize = RATE as usize / 50;
    const PAD: usize = RATE as usize / 5;
    const SPEECH: f32 = 0.01;
    let loud = |f: &[f32]| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt() > SPEECH;
    let frames: Vec<&[f32]> = audio.chunks(FRAME).collect();
    let first = frames.iter().position(|f| loud(f))?;
    let last = frames.iter().rposition(|f| loud(f))?;
    // A click or a breath is not a dictation.
    if last - first < 6 {
        return None;
    }
    let start = (first * FRAME).saturating_sub(PAD);
    let end = ((last + 1) * FRAME + PAD).min(audio.len());
    Some(&audio[start..end])
}

/// Run `f` with `m` loaded, loading it (and dropping any other) first.
fn with_model<T>(
    inner: &Arc<Inner>,
    m: &'static Model,
    path: &Path,
    f: impl FnOnce(&WhisperContext) -> Result<T, String>,
) -> Result<T, String> {
    static REAPER: Once = Once::new();
    REAPER.call_once(|| {
        let inner = Arc::downgrade(inner);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(30));
            let Some(inner) = inner.upgrade() else { return };
            let mut slot = inner.whisper.lock().unwrap();
            if slot.as_ref().is_some_and(|l| l.used.elapsed() > IDLE) {
                *slot = None;
            }
        });
    });

    let mut slot = inner.whisper.lock().unwrap();
    if slot.as_ref().is_none_or(|l| l.id != m.id) {
        *slot = None;
        whisper_rs::install_logging_hooks();
        let path = path
            .to_str()
            .ok_or("The model's path is not valid UTF-8.")?;
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|e| format!("Could not load the dictation model: {e}"))?;
        *slot = Some(Loaded {
            id: m.id,
            ctx,
            used: Instant::now(),
        });
    }
    let loaded = slot.as_mut().expect("loaded above");
    let out = f(&loaded.ctx);
    loaded.used = Instant::now();
    out
}

fn transcribe(
    ctx: &WhisperContext,
    m: &Model,
    audio: &[f32],
    prompt: &str,
    language: &str,
) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Could not start the transcription: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(8);
    params.set_n_threads(threads as i32);
    // An ISO code or "auto", nothing else: a NUL in it would panic whisper-rs.
    let language = match language {
        _ if m.english_only => "en",
        l if (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()) => l,
        _ => "auto",
    };
    params.set_language(Some(language));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Likewise a NUL here, and a panic aborts the app.
    let prompt = prompt.replace('\0', "");
    if !prompt.trim().is_empty() {
        params.set_initial_prompt(prompt.trim());
    }
    state
        .full(params, audio)
        .map_err(|e| format!("The transcription failed: {e}"))?;
    let text: Vec<String> = state
        .as_iter()
        .filter_map(|s| s.to_str_lossy().ok().map(|t| t.trim().to_string()))
        .filter(|t| !is_annotation(t))
        .collect();
    Ok(text.join(" ").trim().to_string())
}

/// `[BLANK_AUDIO]`, `(keyboard clicking)`, `[Music]`: Whisper describing the
/// room rather than transcribing anyone.
fn is_annotation(t: &str) -> bool {
    t.is_empty()
        || (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_are_unique() {
        for (i, a) in MODELS.iter().enumerate() {
            assert!(MODELS[i + 1..]
                .iter()
                .all(|b| b.id != a.id && b.file != a.file));
        }
    }

    #[test]
    fn resample_halves_the_length_from_32k() {
        let input = vec![0.5; 32_000];
        let out = resample(&input, 32_000);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().skip(4).all(|s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resample_leaves_16k_alone() {
        assert_eq!(resample(&[0.1, 0.2], RATE), vec![0.1, 0.2]);
    }

    #[test]
    fn silence_trims_to_nothing() {
        assert!(trim(&vec![0.0; RATE as usize * 2]).is_none());
    }

    #[test]
    fn trim_keeps_speech_with_padding() {
        let mut audio = vec![0.0; RATE as usize * 3];
        for s in &mut audio[RATE as usize..RATE as usize * 2] {
            *s = 0.3;
        }
        let kept = trim(&audio).unwrap();
        let pad = RATE as usize / 5;
        assert_eq!(kept.len(), RATE as usize + 2 * pad);
    }

    #[test]
    fn exact_zeros_mean_a_refused_microphone() {
        let c = Captured {
            samples: vec![0.0; 48_000],
            rate: 48_000,
        };
        assert!(prepare(c).is_err());
    }

    /// A real transcription, from a model and a recording on disk:
    ///
    /// ```sh
    /// say -o /tmp/s.wav --data-format=LEF32@48000 "Open worktree dot r s"
    /// VOICE_MODEL=.../ggml-small.en-q5_1.bin VOICE_WAV=/tmp/s.wav \
    ///   cargo test --release transcribes -- --ignored --nocapture
    /// ```
    ///
    /// The WAV is mono 32-bit float at any rate, as `say` writes it there.
    #[test]
    #[ignore = "needs a downloaded model and a recording"]
    fn transcribes_a_recording() {
        let path = PathBuf::from(std::env::var("VOICE_MODEL").expect("VOICE_MODEL"));
        let wav = fs::read(std::env::var("VOICE_WAV").expect("VOICE_WAV")).unwrap();
        let (mut at, mut rate, mut samples) = (12, 0, Vec::new());
        while at + 8 <= wav.len() {
            let len = u32::from_le_bytes(wav[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &wav[at + 8..(at + 8 + len).min(wav.len())];
            match &wav[at..at + 4] {
                b"fmt " => rate = u32::from_le_bytes(body[4..8].try_into().unwrap()),
                b"data" => {
                    samples = body
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|b| f32::from_le_bytes(*b))
                        .collect()
                }
                _ => {}
            }
            at += 8 + len + (len & 1);
        }
        let m = MODELS
            .iter()
            .find(|m| path.ends_with(m.file))
            .expect("one of MODELS");
        let audio = prepare(Captured { samples, rate })
            .unwrap()
            .expect("speech");
        let inner = Arc::new(Inner::default());
        for _ in 0..2 {
            let started = Instant::now();
            let text = with_model(&inner, m, &path, |ctx| {
                transcribe(ctx, m, &audio, "aditor, worktree.rs, voice.rs", "auto")
            })
            .unwrap();
            eprintln!("{text:?} in {:?}", started.elapsed());
            assert!(text.to_lowercase().contains("worktree"), "{text}");
        }
    }

    #[test]
    fn annotations_are_dropped() {
        assert!(is_annotation("[BLANK_AUDIO]"));
        assert!(is_annotation("(keyboard clicking)"));
        assert!(!is_annotation("Rename the (old) helper"));
    }
}
