//! What a run configuration printed, kept so it can be read back as text: by
//! the agent through `read_run_output` (`mcp.rs`), and by the run tab's "Send
//! to agent".
//!
//! The terminal pane has the output too, but only as xterm.js's screen, and
//! only in the webview. This keeps the raw bytes on the Rust side, bounded,
//! and turns them into plain lines on request -- escape sequences dropped, a
//! progress bar's carriage-return redraws reduced to the last one.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Raw output kept per run. Enough for a long test run's tail and a dev
/// server's recent requests; older bytes go first.
const CAP: usize = 512 * 1024;

pub struct RunLog {
    /// The configuration's name, as its tab shows it.
    pub name: String,
    /// The configuration it was started from.
    pub config_id: String,
    /// The workspace it belongs to; its own cwd may be a folder inside.
    pub root: PathBuf,
    pub started_ms: i64,
    /// None while it runs; then its exit code, itself None when it was killed.
    pub exit: Option<Option<i32>>,
    bytes: VecDeque<u8>,
    /// Older output was dropped to stay under `CAP`.
    trimmed: bool,
}

/// The tail of a log as text.
pub struct Tail {
    pub text: String,
    /// Lines in `text`.
    pub shown: usize,
    /// Lines kept in all, before `lines` and `grep` narrowed them.
    pub total: usize,
    pub trimmed: bool,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl RunLog {
    pub fn new(name: String, config_id: String, root: PathBuf) -> Self {
        RunLog {
            name,
            config_id,
            root,
            started_ms: now_ms(),
            exit: None,
            bytes: VecDeque::new(),
            trimmed: false,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data);
        if self.bytes.len() > CAP {
            let excess = self.bytes.len() - CAP;
            self.bytes.drain(..excess);
            self.trimmed = true;
        }
    }

    /// The last `lines` lines, or with `grep`, the last `lines` of those
    /// containing it, ignoring case.
    pub fn tail(&self, lines: usize, grep: Option<&str>) -> Tail {
        let (front, back) = self.bytes.as_slices();
        let mut raw = Vec::with_capacity(front.len() + back.len());
        raw.extend_from_slice(front);
        raw.extend_from_slice(back);
        let mut all = plain_lines(&String::from_utf8_lossy(&raw));
        // The first line may have lost its start to the cap.
        if self.trimmed && !all.is_empty() {
            all.remove(0);
        }
        let total = all.len();
        let needle = grep.map(str::to_lowercase).filter(|g| !g.is_empty());
        let matching: Vec<&String> = match &needle {
            Some(n) => all.iter().filter(|l| l.to_lowercase().contains(n)).collect(),
            None => all.iter().collect(),
        };
        let start = matching.len().saturating_sub(lines);
        let picked = &matching[start..];
        Tail {
            text: picked.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"),
            shown: picked.len(),
            total,
            trimmed: self.trimmed,
        }
    }

    /// "running for 3m" or "exited with code 1", for a header line.
    pub fn status(&self) -> String {
        match self.exit {
            None => format!("running for {}", age(now_ms() - self.started_ms)),
            Some(Some(0)) => "finished successfully (exit code 0)".to_string(),
            Some(Some(code)) => format!("exited with code {code}"),
            Some(None) => "was stopped".to_string(),
        }
    }
}

fn age(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        _ => format!("{}h {}m", s / 3600, s % 3600 / 60),
    }
}

/// Terminal output as the lines a person would read off the screen: escape
/// sequences and stray control characters dropped, each line what its last
/// carriage return left, trailing blanks trimmed.
pub fn plain_lines(raw: &str) -> Vec<String> {
    let mut lines = Vec::new();
    // The line being built, and the segment since its last carriage return.
    let mut line = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then a final byte in @..~.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC, DCS, SOS, PM, APC: a string, ended by BEL or ESC \.
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // Character set designations take one more character.
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                }
                _ => {}
            },
            '\n' => lines.push(finish(std::mem::take(&mut line))),
            '\x08' => {
                line.pop();
            }
            '\r' | '\t' => line.push(c),
            c if c.is_control() => {}
            c => line.push(c),
        }
    }
    if !line.is_empty() {
        lines.push(finish(line));
    }
    lines
}

/// One line's text: what is left after its last carriage return, unless that
/// return only ended it (CRLF, or a redraw that wrote nothing after).
fn finish(line: String) -> String {
    let text = line
        .split('\r')
        .rev()
        .find(|s| !s.trim().is_empty())
        .unwrap_or("");
    text.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_colours_and_cursor_moves() {
        let raw = "\x1b[1m\x1b[32m✓\x1b[0m passed\r\n\x1b[2K\x1b[1Gnext\n";
        assert_eq!(plain_lines(raw), vec!["✓ passed", "next"]);
    }

    #[test]
    fn strips_titles_and_hyperlinks() {
        let raw = "\x1b]0;title\x07a \x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\ b\n";
        assert_eq!(plain_lines(raw), vec!["a link b"]);
    }

    #[test]
    fn keeps_the_last_redraw_of_a_progress_line() {
        let raw = "build 10%\rbuild 50%\rbuild 100%\r\ndone\n";
        assert_eq!(plain_lines(raw), vec!["build 100%", "done"]);
    }

    #[test]
    fn keeps_a_line_without_a_newline() {
        assert_eq!(plain_lines("a\nlistening on :3000"), vec!["a", "listening on :3000"]);
    }

    #[test]
    fn tails_and_greps() {
        let mut log = RunLog::new("t".into(), "id".into(), PathBuf::from("/"));
        log.push(b"one\nError: two\nthree\nerror: four\n");
        let t = log.tail(2, None);
        assert_eq!(t.text, "three\nerror: four");
        assert_eq!((t.shown, t.total), (2, 4));
        let t = log.tail(10, Some("ERROR"));
        assert_eq!(t.text, "Error: two\nerror: four");
    }

    #[test]
    fn drops_the_oldest_output_and_its_partial_line() {
        let mut log = RunLog::new("t".into(), "id".into(), PathBuf::from("/"));
        log.push(&vec![b'x'; CAP]);
        log.push(b"\nlast\n");
        let t = log.tail(10, None);
        assert!(t.trimmed);
        assert_eq!(t.text, "last");
    }
}
