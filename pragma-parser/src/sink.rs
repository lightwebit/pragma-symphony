use crate::types::{Atom, AtomSink};
use anyhow::Result;

// ---------------------------------------------------------------------------
// StdoutSink — emits every atom as a JSON line on stdout (NDJSON)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct StdoutSink;

impl StdoutSink {
    pub fn new() -> Self {
        Self
    }
}

impl AtomSink for StdoutSink {
    fn push(&mut self, atom: Atom) -> Result<()> {
        println!("{}", serde_json::to_string(&atom)?);
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        Ok(())
    }

    fn finalize(&mut self) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// FanOutSink — forwards every atom to several sinks in sequence
// Used by pragma-cli to feed StdoutSink + SqliteSink together.
// ---------------------------------------------------------------------------

pub struct FanOutSink {
    sinks: Vec<Box<dyn AtomSink>>,
}

impl FanOutSink {
    pub fn new(sinks: Vec<Box<dyn AtomSink>>) -> Self {
        Self { sinks }
    }
}

impl AtomSink for FanOutSink {
    fn push(&mut self, atom: Atom) -> Result<()> {
        for sink in &mut self.sinks {
            sink.push(atom.clone())?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        for sink in &mut self.sinks {
            sink.flush()?;
        }
        Ok(())
    }

    fn finalize(&mut self) -> Result<()> {
        for sink in &mut self.sinks {
            sink.finalize()?;
        }
        Ok(())
    }
}
