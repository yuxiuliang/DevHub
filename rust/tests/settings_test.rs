use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use devhub::{api, engine::Engine, flow::default_flow, settings, store::Store};
use http_body_util::BodyExt;
use rusqlite::params;
use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};
use tower::ServiceExt;

fn fixture() -> (TempDir, Engine) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    {
        let db = store.db.lock().unwrap();
        for room in ["room", "other"] {
            db.execute("INSERT INTO rooms (id,name,repo_path,flow_json,planner_id,reviewer_id,created_at,updated_at) VALUES (?,?,?,?,'a','b','then','then')",
                params![room, room, "unused", default_flow().to_string()]).unwrap();
        }
        for (id, room, name, sort) in [
            ("a", "room", "计划者", 0),
            ("b", "room", "评审者", 1),
            ("foreign", "other", "外部", 0),
        ] {
            db.execute(
                "INSERT INTO members (id,room_id,name,worker,sort) VALUES (?,?,?,'claude',?)",
                params![id, room, name, sort],
            )
            .unwrap();
        }
    }
    (dir, Engine::new(store))
}

fn draft(engine: &Engine) -> Value {
    let current = settings::read(&engine.store, "room").unwrap();
    json!({"version": current["version"], "settings": current["settings"]})
}

async fn request(
    engine: &Engine,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> (StatusCode, Value) {
    let response = api::router(engine.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(
                    body.map(|v| Body::from(v.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn settings_api_roundtrip_conflicts_and_status_codes() {
    let (_dir, engine) = fixture();
    let (status, current) = request(&engine, "GET", "/api/rooms/room/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(current["roomId"], "room");
    let mut input = draft(&engine);
    input["settings"]["name"] = json!("  已保存  ");
    input["settings"]["members"][0]["role_brief"] = json!("第一行\n第二行");
    let mut events = engine.store.subscribe();
    let (status, saved) = request(&engine, "PATCH", "/api/rooms/room/settings", Some(&input)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["settings"]["name"], "已保存");
    assert_ne!(saved["version"], current["version"]);
    assert_eq!(events.try_recv().unwrap()["type"], "room.settings_updated");
    assert_eq!(
        request(&engine, "PATCH", "/api/rooms/room/settings", Some(&input))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert!(events.try_recv().is_err());
    assert_eq!(
        request(
            &engine,
            "PATCH",
            "/api/rooms/room/settings",
            Some(&json!({}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&engine, "GET", "/api/rooms/missing/settings", None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    engine
        .store
        .db
        .lock()
        .unwrap()
        .execute("UPDATE rooms SET status='archived' WHERE id='room'", [])
        .unwrap();
    assert_eq!(
        request(
            &engine,
            "PATCH",
            "/api/rooms/room/settings",
            Some(&draft(&engine))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn settings_transaction_rolls_back_late_database_failure() {
    let (_dir, engine) = fixture();
    let before = settings::read(&engine.store, "room").unwrap();
    engine.store.db.lock().unwrap().execute_batch("CREATE TRIGGER reject_room_update BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
    let mut input = draft(&engine);
    input["settings"]["members"][0]["name"] = json!("不应保留");
    input["settings"]["members"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"new","name":"新成员","worker":"dsh","concurrency":2,"enabled":true}));
    let mut events = engine.store.subscribe();
    let error = engine.save_room_settings("room", &input).await.unwrap_err();
    assert!(error.to_string().contains("injected write failure"));
    assert_eq!(settings::read(&engine.store, "room").unwrap(), before);
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn settings_validate_members_and_resolve_new_principal_ids() {
    let (_dir, engine) = fixture();
    let original = draft(&engine);
    let mut input = original.clone();
    input["settings"]["members"].as_array_mut().unwrap().push(
        json!({"key":"foreign","name":"新成员","worker":"claude","concurrency":1,"enabled":true}),
    );
    assert_eq!(
        settings::save(&engine.store, "room", &input)
            .unwrap_err()
            .status,
        400
    );
    input = original.clone();
    input["settings"]["members"][0]["enabled"] = json!(false);
    assert_eq!(
        settings::save(&engine.store, "room", &input)
            .unwrap_err()
            .status,
        400
    );
    input = original.clone();
    input["settings"]["members"][0]["key"] = json!("renamed-key");
    assert_eq!(
        settings::save(&engine.store, "room", &input)
            .unwrap_err()
            .status,
        400
    );
    input = original.clone();
    input["settings"]["members"][0]["model"] = json!("bad\nmodel");
    assert_eq!(
        settings::save(&engine.store, "room", &input)
            .unwrap_err()
            .status,
        400
    );
    input = original.clone();
    input["settings"]["members"][1]["name"] = input["settings"]["members"][0]["name"].clone();
    assert_eq!(
        settings::save(&engine.store, "room", &input)
            .unwrap_err()
            .status,
        400
    );
    for concurrency in [json!(0), json!(11), json!(1.5), json!("2"), json!(true)] {
        input = original.clone();
        input["settings"]["members"][0]["concurrency"] = concurrency;
        assert_eq!(
            settings::save(&engine.store, "room", &input)
                .unwrap_err()
                .status,
            400
        );
    }
    input = original.clone();
    input["settings"]["members"][0]["concurrency"] = json!(1.0);
    assert_eq!(
        settings::save(&engine.store, "room", &input).unwrap()["settings"]["members"][0]
            ["concurrency"],
        1
    );
    assert_eq!(draft(&engine), original);
    input = original;
    input["settings"]["members"].as_array_mut().unwrap().push(
        json!({"key":"draft-new","name":"新成员","worker":"dsh","concurrency":3,"enabled":true}),
    );
    input["settings"]["plannerKey"] = json!("draft-new");
    let saved = engine.save_room_settings("room", &input).await.unwrap();
    let members = saved["settings"]["members"].as_array().unwrap();
    assert_eq!(members.len(), 3);
    assert_eq!(saved["settings"]["plannerKey"], members[2]["id"]);
    assert_eq!(members[2]["id"], members[2]["key"]);
    assert_ne!(members[2]["id"], "draft-new");
}

#[test]
fn concurrent_settings_writers_allow_one_revision_only() {
    let (_dir, engine) = fixture();
    let input = draft(&engine);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|name| {
            let store = engine.store.clone();
            let barrier = barrier.clone();
            let mut input = input.clone();
            input["settings"]["name"] = json!(name);
            std::thread::spawn(move || {
                barrier.wait();
                settings::save(&store, "room", &input)
                    .map(|_| 200)
                    .unwrap_or_else(|error| error.status)
            })
        })
        .collect();
    let mut statuses: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 409]);
}

#[tokio::test]
async fn owned_member_deletion_rejects_entire_draft() {
    let (_dir, engine) = fixture();
    engine.store.db.lock().unwrap().execute("INSERT INTO tasks (id,room_id,key,title,owner_id,created_at,updated_at) VALUES ('task','room','T1','任务','b','then','then')", []).unwrap();
    let original = draft(&engine);
    let mut input = original.clone();
    input["settings"]["name"] = json!("不应保留");
    input["settings"]["members"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    input["settings"]["reviewerKey"] = json!("a");
    assert!(settings::save(&engine.store, "room", &input)
        .unwrap_err()
        .message
        .contains("任务"));
    assert_eq!(draft(&engine), original);
}

#[tokio::test]
async fn flow_requires_cas_and_valid_graph_without_invalidating_settings_version() {
    let (_dir, engine) = fixture();
    let initial_settings = draft(&engine);
    let flow = default_flow();
    let next =
        json!({"nodes":[{"id":"custom","name":"新阶段","x":0,"y":10,"owner":"计划者"}],"edges":[]});
    let path = "/api/rooms/room";
    assert_eq!(
        request(&engine, "PATCH", path, Some(&json!({"flow":next})))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    for invalid in [
        json!(null),
        json!({"nodes":[],"edges":[{"from":"missing","to":"missing"}]}),
        json!({"nodes":[{"id":"same"},{"id":"same"}],"edges":[]}),
        json!({"nodes":[{"id":"n","x":-1}],"edges":[]}),
        json!({"nodes":[{"id":"n","outputs":"bad"}],"edges":[]}),
        json!({"nodes":[{"id":"n","outputs":["valid",42]}],"edges":[]}),
    ] {
        assert_eq!(
            request(
                &engine,
                "PATCH",
                path,
                Some(&json!({"flow":invalid,"expectedFlow":flow}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            engine.store.room("room").unwrap().unwrap().flow_json,
            flow.to_string()
        );
    }
    engine
        .store
        .db
        .lock()
        .unwrap()
        .execute("UPDATE rooms SET status='running' WHERE id='room'", [])
        .unwrap();
    let patch = json!({"flow":next,"expectedFlow":flow});
    assert_eq!(
        request(&engine, "PATCH", path, Some(&patch)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&engine, "PATCH", path, Some(&patch)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(draft(&engine), initial_settings);
    assert_eq!(
        request(
            &engine,
            "PATCH",
            path,
            Some(&json!({"flow":next,"expectedFlow":next}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(engine
        .save_room_settings("room", &initial_settings)
        .await
        .is_ok());
}
