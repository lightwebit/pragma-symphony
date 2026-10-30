use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Session events — envelope with sessionId (parallel sessions)
//
// Tauri events are global by construction: with a single session at a time the
// event name was enough, with several sessions running the frontend must be able
// to say *whose* an atom or a phase is. Every session-bound event therefore
// travels as `{ sessionId, payload }` and the router in the store delivers it to the
// right record; payloads that belong to no session (`pragma:e2e`,
// which is per project, and `session:debug`) stay bare.
// ---------------------------------------------------------------------------

/// Emits a session event in the `{ sessionId, payload }` envelope.
pub fn emit_session<S: Serialize>(app: &AppHandle, event: &str, session_id: &str, payload: S) {
    let envelope = match serde_json::to_value(payload) {
        Ok(v) => serde_json::json!({ "sessionId": session_id, "payload": v }),
        Err(e) => {
            let _ = app.emit(
                "session:debug",
                format!("[events] payload not serializable for {event}: {e}"),
            );
            return;
        }
    };
    let _ = app.emit(event, envelope);
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    #[derive(Serialize)]
    struct Payload {
        text: String,
    }

    /// The shape of the envelope is a contract with the store router: if it changes here
    /// it must change in `session.ts` too.
    #[test]
    fn envelope_shape_is_session_id_plus_payload() {
        let payload = Payload {
            text: "ciao".to_string(),
        };
        let envelope = serde_json::json!({
            "sessionId": "abc",
            "payload": serde_json::to_value(&payload).unwrap(),
        });
        assert_eq!(envelope["sessionId"], "abc");
        assert_eq!(envelope["payload"]["text"], "ciao");
    }
}
