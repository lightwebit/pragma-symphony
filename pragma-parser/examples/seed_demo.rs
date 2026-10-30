//! Fills `~/.pragma` (HOME / USERPROFILE) with invented but plausible data, so the
//! screenshots in `docs/screenshots/` can be regenerated without touching a real database.
//! Run by `.autotest/wdio/screenshots.conf.js` against a throwaway home; never run it
//! against your own.
//!
//! `cargo run -p pragma-parser --example seed_demo -- <demo-root>`

use chrono::{Duration, Utc};
use pragma_parser::settings::{load_settings, save_settings, Profile};
use pragma_parser::storage::{self, PipelineStep, SqliteSink, Usage};
use pragma_parser::types::*;
use uuid::Uuid;

struct Seeder {
    sink: SqliteSink,
    sid: Uuid,
    t0: chrono::DateTime<Utc>,
    t: chrono::DateTime<Utc>,
}

impl Seeder {
    fn push(&mut self, atom_type: AtomType, content: &str) {
        self.atom(atom_type, content, None, None, None, false);
    }

    fn atom(
        &mut self,
        atom_type: AtomType,
        content: &str,
        file_path: Option<&str>,
        file_type: Option<FileType>,
        action: Option<FileAction>,
        collapsed: bool,
    ) {
        self.t += Duration::seconds(4);
        self.sink
            .push(Atom {
                id: Uuid::new_v4(),
                atom_type,
                file_path: file_path.map(str::to_string),
                file_type,
                action,
                content: content.to_string(),
                collapsed,
                source: OutputSource::Stdout,
                received_at: self.t,
                session_id: self.sid,
            })
            .unwrap();
    }

    fn touch(&mut self, path: &str, ft: FileType, action: FileAction) {
        self.atom(
            AtomType::FileTouch,
            "",
            Some(path),
            Some(ft),
            Some(action),
            false,
        );
    }

    fn tool(&mut self, name: &str, json: &str) {
        self.atom(
            AtomType::ToolUse,
            &format!("{name}\n{json}"),
            None,
            None,
            None,
            true,
        );
    }

    fn diff(&mut self, path: &str, hunks: &str) {
        self.atom(
            AtomType::Diff,
            hunks,
            Some(path),
            Some(FileType::Code),
            Some(FileAction::Modify),
            true,
        );
    }

    fn pragma(&mut self, label: &str, body: &str) {
        self.push(AtomType::PragmaEvent, &format!("{label}\n{body}"));
    }

    fn finish(mut self, title: &str, usage: Usage, cost: f64) {
        self.sink.finalize().unwrap();
        let id = self.sid.to_string();
        storage::update_session_title(&id, title).unwrap();
        storage::update_session_usage(&id, usage, Some(cost)).unwrap();
        // `SqliteSink::new` stamps "now"; spread the sessions over the past days instead.
        let conn = rusqlite::Connection::open(storage::pragma_db_path().unwrap()).unwrap();
        conn.execute(
            "UPDATE sessions SET started_at = ?1 WHERE id = ?2",
            rusqlite::params![self.t0.to_rfc3339(), id],
        )
        .unwrap();
    }
}

fn session(project_id: &str, prompt: &str, dir: &str, started_ago_min: i64, model: &str) -> Seeder {
    let sid = Uuid::new_v4();
    let sink = SqliteSink::new(
        sid,
        project_id,
        Some("claude"),
        None,
        Some(dir),
        None,
        None,
        Some(model),
    )
    .unwrap();
    let t0 = Utc::now() - Duration::minutes(started_ago_min);
    let mut s = Seeder {
        sink,
        sid,
        t0,
        t: t0,
    };
    s.push(AtomType::UserReply, prompt);
    s
}

fn usage(i: u64, o: u64, cr: u64, cw: u64) -> Usage {
    Usage {
        input: i,
        output: o,
        cache_read: cr,
        cache_write: cw,
    }
}

const HUNK_CART: &str = r#"[{"oldStart":41,"oldLines":7,"newStart":41,"newLines":12,"lines":[" export function cartTotal(items: CartItem[]): number {","-  return items.reduce((sum, i) => sum + i.price * i.qty, 0)","+  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0)","+  return applyDiscount(subtotal, items)"," }"," ","+function applyDiscount(subtotal: number, items: CartItem[]): number {","+  const bulk = items.some(i => i.qty >= 10) ? 0.05 : 0","+  return Math.round(subtotal * (1 - bulk) * 100) / 100","+}"]}]"#;

const HUNK_ROUTE: &str = r#"[{"oldStart":12,"oldLines":4,"newStart":12,"newLines":9,"lines":["   router.get('/orders/:id', auth, async (req, res) => {","-    const order = await db.orders.find(req.params.id)","+    const order = await db.orders.find(req.params.id)","+    if (!order) return res.status(404).json({ error: 'order not found' })","+    if (order.userId !== req.user.id) return res.status(403).end()","     res.json(order)","   })"]}]"#;

fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("usage: seed_demo <demo-root>")
        .replace('/', "\\");
    let atlas_dir = format!("{root}\\atlas-shop");
    let notes_dir = format!("{root}\\notes-api");
    let mobile_dir = format!("{root}\\field-notes-app");
    for d in [&atlas_dir, &notes_dir, &mobile_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    // A test command that exists and passes, so a session played from the UI gets a green VERIFY.
    std::fs::write(
        format!(r"{atlas_dir}\package.json"),
        r#"{"name":"atlas-shop","private":true,"scripts":{"test":"echo Tests 133 passed (133)","lint":"echo eslint: 0 problems"}}"#,
    )
    .unwrap();

    // Settings: one profile, nothing else personal.
    let mut settings = load_settings().unwrap();
    settings.profiles = vec![Profile {
        label: "Personal".into(),
        binary: format!(r"{root}\bin\claude.exe"),
        config_dir: None,
        language: Some("en".into()),
        system_prompt: None,
    }];
    settings.last_working_dir = Some(atlas_dir.clone());
    settings.notifications_enabled = true;
    settings.export_dir = Some(format!("{root}\\exports"));
    save_settings(&settings).unwrap();
    // Sessions started from the UI are not asked to confirm the directory.
    std::fs::write(
        std::path::Path::new(&std::env::var("USERPROFILE").unwrap())
            .join(".pragma")
            .join("trusted_dirs.json"),
        serde_json::to_string(&[&atlas_dir, &notes_dir, &mobile_dir]).unwrap(),
    )
    .unwrap();

    // ── Projects ────────────────────────────────────────────────────────────
    let atlas = storage::create_project(
        "Atlas Shop",
        Some("Storefront and order API for a small online shop"),
        Some(&atlas_dir),
        Some("#7c6ff0"),
        Some("npm test"),
        Some("npm run lint"),
        None,
        Some("- Prices are integers in cents everywhere except the display layer.\n- Every order route checks that the order belongs to the caller.\n- No new dependency without a reason in the PR."),
        Some("src/auth/**\nsrc/payments/**"),
        Some("web"),
        Some("Vue 3, Node, PostgreSQL"),
    )
    .unwrap();
    let notes = storage::create_project(
        "Notes API",
        Some("Small REST service for notes with tags"),
        Some(&notes_dir),
        Some("#2fa57d"),
        Some("cargo test"),
        None,
        None,
        None,
        None,
        Some("api"),
        Some("Rust, axum, SQLite"),
    )
    .unwrap();
    let mobile = storage::create_project(
        "Field Notes App",
        Some("Offline-first notes app for field work"),
        Some(&mobile_dir),
        Some("#d9822b"),
        Some("npm test"),
        None,
        None,
        None,
        None,
        Some("mobile"),
        Some("React Native"),
    )
    .unwrap();

    storage::update_live_command(
        &atlas.id,
        Some("echo VITE v5.4.2 ready in 312 ms && echo   Local:   http://localhost:5173/"),
    )
    .unwrap();
    storage::update_e2e_config(
        &atlas.id,
        Some("npx playwright test"),
        Some("npm run dev"),
        Some("playwright"),
    )
    .unwrap();
    storage::replace_pipeline_steps(
        &atlas.id,
        &[
            PipelineStep {
                id: Uuid::new_v4().to_string(),
                label: "Lint".into(),
                command: "echo eslint: 0 problems".into(),
                kind: "command".into(),
                enabled: true,
            },
            PipelineStep {
                id: Uuid::new_v4().to_string(),
                label: "Build".into(),
                command: "echo vite build: 212 modules transformed, built in 4.2s".into(),
                kind: "command".into(),
                enabled: true,
            },
            PipelineStep {
                id: Uuid::new_v4().to_string(),
                label: "Tests".into(),
                command: String::new(),
                kind: "verify".into(),
                enabled: false,
            },
        ],
    )
    .unwrap();

    for (text, done) in [
        ("Add pagination to the orders list", false),
        ("Write the refund flow", false),
        ("Rotate the staging API keys", false),
        ("Fix the cart rounding on bulk discounts", true),
        ("Upgrade vite to 5.4", true),
    ] {
        let todo = storage::create_todo(&atlas.id, text).unwrap();
        if done {
            storage::set_todo_done(&todo.id, true).unwrap();
        }
    }

    for (prompt, title, hours, step, auto) in [
        (
            "Add an index on orders.created_at and measure the list query before and after.",
            "Index on orders.created_at",
            20,
            false,
            false,
        ),
        (
            "Add a CSV export to the orders page, behind the admin role.",
            "CSV export for orders",
            52,
            true,
            false,
        ),
        (
            "Update the README with the new environment variables.",
            "README: environment variables",
            120,
            false,
            true,
        ),
    ] {
        let run_at = (Utc::now() + Duration::hours(hours)).to_rfc3339();
        storage::create_scheduled_session(
            &atlas.id,
            prompt,
            &run_at,
            Some(&atlas_dir),
            Some("Personal"),
            Some("sonnet"),
            &[],
            Some(title),
            step,
            auto,
        )
        .unwrap();
    }

    // ── Sessions: Atlas Shop ────────────────────────────────────────────────
    // 1. Clean run: every phase, tests, VERIFY green, REVIEW with findings.
    {
        let mut s = session(
            &atlas.id,
            "The cart total ignores bulk discounts. Orders of 10 or more of the same item should get 5% off. Add it and cover it with tests.",
            &atlas_dir,
            38,
            "sonnet",
        );
        s.push(
            AtomType::AgentNote,
            "Looking at how the cart total is computed.",
        );
        s.tool("Grep", r#"{"pattern":"cartTotal","path":"src"}"#);
        s.touch("src/cart/total.ts", FileType::Code, FileAction::Modify);
        s.pragma("ANALYSIS", "The total is computed in one place, `cartTotal` in `src/cart/total.ts`, and every consumer (checkout, the order summary, the invoice PDF) calls it. A discount there reaches all of them, so the change is small and local.\nPrices are integers in cents, so the discount must round to a whole cent.");
        s.pragma("QUESTIONS", "1. Should the 5% apply per line (10+ of one item) or to the whole cart once it has 10 items?\n   - Per line\n   - Whole cart\n2. Do bulk discounts stack with a coupon code?\n   - Yes, bulk first, then the coupon\n   - No, the better one wins");
        s.push(
            AtomType::UserReply,
            "→ Q1=Per line\nQ2=No, the better one wins",
        );
        s.pragma("PLAN", "- Add `applyDiscount` to `src/cart/total.ts` (5% on lines with qty >= 10, rounded to the cent)\n- Keep the coupon path untouched: the better of the two wins\n- Add unit tests for the thresholds (9, 10, 11) and for rounding\n- Run the full suite");
        s.push(AtomType::UserReply, "✓ APPROVED");
        s.diff("src/cart/total.ts", HUNK_CART);
        s.touch("src/cart/total.test.ts", FileType::Code, FileAction::Create);
        s.tool(
            "Bash",
            r#"{"command":"npm test -- --run","description":"Run the unit tests"}"#,
        );
        s.pragma(
            "STEP 1",
            "`applyDiscount` added; the coupon path is unchanged.",
        );
        s.pragma(
            "STEP 2",
            "Tests added for 9, 10 and 11 items and for rounding to the cent.",
        );
        s.pragma("REPORT", "Bulk discount in place: lines with 10 or more of the same item get 5% off, rounded to the cent. Checkout, summary and invoice pick it up through `cartTotal`. 4 tests added.");
        s.pragma("TESTS", "- 9 items: no discount\n- 10 items: 5% off\n- 11 items: 5% off\n- Rounding to the cent on an odd price");
        s.pragma(
            "VERIFY",
            r#"{"passed":true,"newFailures":[],"healed":["cart > total with coupon"],"preexisting":[],"lintOutput":null,"undetermined":false,"rawTestOutput":"Test Files  14 passed (14)\n     Tests  131 passed (131)\n  Duration  6.82s"}"#,
        );
        s.pragma(
            "REVIEW",
            r#"{"verdict":"findings","findings":[{"severity":"high","file":"src/cart/total.ts","line":47,"summary":"The discount ignores the coupon rule you chose","detail":"applyDiscount always runs, then the coupon is applied on the discounted subtotal, so the two stack. You said the better one should win: compare the two totals and keep the lower."},{"severity":"low","file":"src/cart/total.test.ts","line":12,"summary":"No test for an empty cart","detail":null}],"note":null,"diffTruncated":false,"round":1,"usedInvariants":true,"filesChanged":2,"linesChanged":38,"deepReviewSuggested":false,"securityPass":false,"sensitiveFiles":[],"sensitiveFromDefaults":false}"#,
        );
        s.pragma("CLOSING", "Bulk discount shipped on `src/cart/total.ts`. One review finding is open (coupon stacking).");
        storage::update_session_attachments(
            &s.sid.to_string(),
            &[
                "cart-mockup.png".to_string(),
                "discount-rules.md".to_string(),
            ],
        )
        .unwrap();
        s.finish(
            "Bulk discount in the cart total",
            usage(5_210, 11_480, 412_900, 38_700),
            0.74,
        );
    }
    // 2. Security pass in REVIEW + step-by-step.
    {
        let mut s = session(
            &atlas.id,
            "A user can read other users' orders by changing the id in the URL. Fix it.",
            &atlas_dir,
            130,
            "opus",
        );
        s.pragma("ANALYSIS", "`GET /orders/:id` loads the order by id and returns it without checking who owns it. Any logged-in user can read any order.");
        s.pragma("PLAN", "- Return 404 when the order does not exist\n- Return 403 when it belongs to someone else\n- Add a test for each case");
        s.push(AtomType::UserReply, "✓ APPROVED");
        s.diff("src/routes/orders.ts", HUNK_ROUTE);
        s.touch(
            "src/routes/orders.test.ts",
            FileType::Code,
            FileAction::Modify,
        );
        s.pragma(
            "STEP 1",
            "Ownership check added in the route; 404 and 403 answered.",
        );
        s.pragma("STEP 2", "Two tests added, one per case.");
        s.pragma("REPORT", "Orders are now readable only by their owner. A missing order answers 404, someone else's 403.");
        s.pragma(
            "TESTS",
            "- Own order: 200\n- Someone else's order: 403\n- Unknown id: 404",
        );
        s.pragma(
            "VERIFY",
            r#"{"passed":true,"newFailures":[],"healed":[],"preexisting":["payments > refunds rounding"],"lintOutput":null,"undetermined":false,"rawTestOutput":"Test Files  14 passed (14)\n     Tests  133 passed (133)"}"#,
        );
        s.pragma(
            "REVIEW",
            r#"{"verdict":"pass","findings":[],"note":null,"diffTruncated":false,"round":2,"usedInvariants":true,"filesChanged":2,"linesChanged":21,"deepReviewSuggested":false,"securityPass":true,"sensitiveFiles":["src/routes/orders.ts"],"sensitiveFromDefaults":true}"#,
        );
        s.finish(
            "Order ownership check",
            usage(4_100, 9_800, 351_200, 29_400),
            1.12,
        );
    }
    // 3. Error.
    {
        let mut s = session(
            &atlas.id,
            "Migrate the sessions table to UUID primary keys.",
            &atlas_dir,
            300,
            "sonnet",
        );
        s.pragma("ANALYSIS", "The `sessions` table uses a serial id that three other tables reference. Changing it needs a data migration, not just a column type.");
        s.atom(
            AtomType::Error,
            "API Error: 529 Overloaded. The service is temporarily busy, try again in a moment.",
            None,
            None,
            None,
            false,
        );
        s.finish(
            "UUID keys for sessions",
            usage(1_900, 640, 22_100, 9_800),
            0.09,
        );
    }
    // 4. Raw note, no protocol.
    {
        let mut s = session(
            &atlas.id,
            "What does the checkout flow do when the payment provider times out?",
            &atlas_dir,
            480,
            "sonnet",
        );
        s.push(AtomType::AgentNote, "I read `src/payments/checkout.ts`.");
        s.pragma("RAW_NOTE", "On a timeout the order is saved as `pending_payment` and the cart is kept. A background job retries the charge three times, ten minutes apart, then marks the order `payment_failed` and emails the customer. Nothing is charged twice: each attempt reuses the same idempotency key.");
        s.finish(
            "Checkout on payment timeout",
            usage(2_300, 520, 61_000, 7_400),
            0.07,
        );
    }
    // 5-8 older, to fill the list.
    for (prompt, title, mins, model) in [
        (
            "Upgrade vite to 5.4 and fix the deprecation warnings.",
            "Upgrade vite to 5.4",
            1_500,
            "sonnet",
        ),
        (
            "Add a dark mode toggle to the storefront header.",
            "Dark mode toggle",
            2_900,
            "sonnet",
        ),
        (
            "Why is the product list slow on the first load?",
            "Slow first load of the product list",
            4_300,
            "opus",
        ),
        (
            "Add rate limiting to the login route.",
            "Rate limit on login",
            7_200,
            "sonnet",
        ),
    ] {
        let mut s = session(&atlas.id, prompt, &atlas_dir, mins, model);
        s.pragma(
            "ANALYSIS",
            "Looked at the relevant code; the change is contained.",
        );
        s.pragma("REPORT", "Done and covered by tests.");
        s.finish(title, usage(3_000, 5_000, 180_000, 20_000), 0.38);
    }

    // ── Sessions: other projects ────────────────────────────────────────────
    for (pid, dir, prompt, title, mins) in [
        (
            &notes.id,
            &notes_dir,
            "Add a `tag` filter to GET /notes.",
            "Tag filter on /notes",
            90,
        ),
        (
            &notes.id,
            &notes_dir,
            "Return 409 instead of 500 when a note title already exists.",
            "409 on duplicate title",
            600,
        ),
        (
            &mobile.id,
            &mobile_dir,
            "The sync banner stays visible after going back online.",
            "Sync banner stuck",
            240,
        ),
    ] {
        let mut s = session(pid, prompt, dir, mins, "sonnet");
        s.pragma("ANALYSIS", "A small, contained change.");
        s.pragma("REPORT", "Done and covered by tests.");
        s.finish(title, usage(2_800, 4_100, 120_000, 14_000), 0.29);
    }

    println!(
        "seeded: {} projects",
        storage::list_projects().unwrap().len()
    );
}
