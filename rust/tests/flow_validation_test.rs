use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use devhub::{api, engine::Engine, flow::default_flow, store::Store};
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
        db.execute(
            "INSERT INTO rooms (id,name,repo_path,flow_json,planner_id,reviewer_id,created_at,updated_at) VALUES ('room','room','unused',?,'a','b','then','then')",
            params![default_flow().to_string()],
        )
        .unwrap();
        for (id, name, enabled, sort) in [
            ("a", "计划者", 1, 0),
            ("b", "评审者", 1, 1),
            ("c", "停用成员", 0, 2),
        ] {
            db.execute(
                "INSERT INTO members (id,room_id,name,worker,enabled,sort) VALUES (?,'room',?,'claude',?,?)",
                params![id, name, enabled, sort],
            )
            .unwrap();
        }
    }
    (dir, Engine::new(store))
}

fn stored_flow(engine: &Engine) -> Value {
    serde_json::from_str(&engine.store.room("room").unwrap().unwrap().flow_json).unwrap()
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

async fn save_ok(engine: &Engine, flow: &Value) {
    let body = json!({"flow": flow, "expectedFlow": stored_flow(engine)});
    let (status, saved) = request(engine, "PATCH", "/api/rooms/room", Some(&body)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(&stored_flow(engine), flow);
    assert_eq!(&saved["room"]["flow"], flow);
}

async fn expect_rejected(engine: &Engine, flow: &Value, message: &str) {
    let before = engine.store.room("room").unwrap().unwrap();
    let mut events = engine.store.subscribe();
    let body = json!({
        "flow": flow,
        "expectedFlow": stored_flow(engine),
        "name": "不应写入",
        "requirement": "不应写入",
    });
    let (status, payload) = request(engine, "PATCH", "/api/rooms/room", Some(&body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert_eq!(payload["error"], message);
    let after = engine.store.room("room").unwrap().unwrap();
    assert_eq!(after.flow_json, before.flow_json);
    assert_eq!(after.name, before.name);
    assert_eq!(after.requirement, before.requirement);
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn valid_flows_save_with_back_edges_and_empty_graph_is_allowed() {
    let (_dir, engine) = fixture();
    save_ok(&engine, &default_flow()).await;
    for key in ["generic", "code", "document", "research", "blank"] {
        save_ok(&engine, &devhub::flow::starter_flow(key).unwrap()).await;
    }
    save_ok(&engine, &json!({"nodes": [], "edges": []})).await;

    let rework = json!({
        "id": "flow-rework",
        "name": "带打回",
        "nodes": [
            {"id":"n1","type":"phase","name":"澄清","owner":"计划者","gate":"human","outputs":[],"x":0,"y":0,"maxLoop":0},
            {"id":"n2","type":"phase","name":"执行","owner":"停用成员","gate":"auto","outputs":["code_diff"],"x":230,"y":0,"maxLoop":0},
            {"id":"n3","type":"phase","name":"评审","owner":"评审者","gate":"agent","outputs":["review_report"],"x":460,"y":40,"maxLoop":2}
        ],
        "edges": [
            {"from":"n1","to":"n2","condition":"passed"},
            {"from":"n2","to":"n3","condition":"passed"},
            {"from":"n3","to":"n2","condition":"rejected"}
        ]
    });
    save_ok(&engine, &rework).await;

    // 上限 1 是最小的合法打回回边。
    let minimal_rework = json!({
        "nodes": [
            {"id":"a","name":"开始"},
            {"id":"b","name":"执行"},
            {"id":"c","name":"评审","maxLoop":1}
        ],
        "edges": [
            {"from":"a","to":"b","condition":"passed"},
            {"from":"b","to":"c","condition":"passed"},
            {"from":"c","to":"b","condition":"rejected"}
        ]
    });
    save_ok(&engine, &minimal_rework).await;

    // 互相打回（两条 rejected 边成环）只要上限足够也合法。
    let mutual_rework = json!({
        "nodes": [
            {"id":"n1","name":"起点"},
            {"id":"a","name":"A","maxLoop":2},
            {"id":"b","name":"B","maxLoop":2}
        ],
        "edges": [
            {"from":"n1","to":"a","condition":"passed"},
            {"from":"a","to":"b","condition":"rejected"},
            {"from":"b","to":"a","condition":"rejected"}
        ]
    });
    save_ok(&engine, &mutual_rework).await;

    // 不构成回边的 rejected 边不需要 maxLoop。
    let forward_reject = json!({
        "nodes": [
            {"id":"n1","name":"开始","maxLoop":0},
            {"id":"n2","name":"执行"},
            {"id":"n3","name":"终止"}
        ],
        "edges": [
            {"from":"n1","to":"n2","condition":"passed"},
            {"from":"n2","to":"n3","condition":"rejected"}
        ]
    });
    save_ok(&engine, &forward_reject).await;

    // 空 owner、未设置 owner、timeout / always 条件都合法。
    let loose = json!({
        "nodes": [
            {"id":"a","name":"A","owner":"","x":0,"y":0},
            {"id":"b","name":"B","gate":"auto"},
            {"id":"c","name":"C"}
        ],
        "edges": [
            {"from":"a","to":"b","condition":"timeout"},
            {"from":"a","to":"c","condition":"always"}
        ]
    });
    save_ok(&engine, &loose).await;
}

#[tokio::test]
async fn structural_rules_reject_with_exact_messages_and_leave_room_untouched() {
    let (_dir, engine) = fixture();
    let cases: Vec<(Value, &str)> = vec![
        (json!(null), "流程必须是对象"),
        (json!([1, 2]), "流程必须是对象"),
        (json!({}), "流程阶段必须是数组"),
        (json!({"nodes":{},"edges":[]}), "流程阶段必须是数组"),
        (json!({"nodes":[],"edges":{}}), "流程连线必须是数组"),
        (json!({"nodes":[null],"edges":[]}), "流程阶段格式无效"),
        (json!({"nodes":[[]],"edges":[]}), "流程阶段格式无效"),
        (
            json!({"nodes":[{"id":""}],"edges":[]}),
            "流程阶段必须有有效标识",
        ),
        (
            json!({"nodes":[{"id":"   "}],"edges":[]}),
            "流程阶段必须有有效标识",
        ),
        (
            json!({"nodes":[{"id":7}],"edges":[]}),
            "流程阶段必须有有效标识",
        ),
        (
            json!({"nodes":[{"id":"a"},{"id":"a"}],"edges":[]}),
            "流程阶段标识重复：a",
        ),
        (
            json!({"nodes":[{"id":"a","outputs":"x"}],"edges":[]}),
            "流程阶段产出必须是文字标签列表",
        ),
        (
            json!({"nodes":[{"id":"a","outputs":["ok",2]}],"edges":[]}),
            "流程阶段产出必须是文字标签列表",
        ),
        (
            json!({"nodes":[{"id":"a","outputs":null}],"edges":[]}),
            "流程阶段产出必须是文字标签列表",
        ),
        (
            json!({"nodes":[{"id":"a","x":-1}],"edges":[]}),
            "流程阶段位置 x 必须是有限的非负数",
        ),
        (
            json!({"nodes":[{"id":"a","y":"0"}],"edges":[]}),
            "流程阶段位置 y 必须是有限的非负数",
        ),
        (
            json!({"nodes":[{"id":"a","x":null}],"edges":[]}),
            "流程阶段位置 x 必须是有限的非负数",
        ),
        (
            json!({"nodes":[{"id":"a","type":"gate"}],"edges":[]}),
            "流程阶段类型只支持 phase",
        ),
        (
            json!({"nodes":[{"id":"a","type":null}],"edges":[]}),
            "流程阶段类型只支持 phase",
        ),
        (
            json!({"nodes":[{"id":"a","gate":"manual"}],"edges":[]}),
            "流程阶段完成条件只支持 auto / agent / human",
        ),
        (
            json!({"nodes":[{"id":"a","gate":null}],"edges":[]}),
            "流程阶段完成条件只支持 auto / agent / human",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":1.5}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":"2"}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":-1}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":10}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":null}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","maxLoop":true}],"edges":[]}),
            "回边上限必须是 0-9 的整数",
        ),
        (
            json!({"nodes":[{"id":"a","owner":42}],"edges":[]}),
            "流程阶段负责人必须是成员名字",
        ),
        (
            json!({"nodes":[{"id":"a","owner":null}],"edges":[]}),
            "流程阶段负责人必须是成员名字",
        ),
        (
            json!({"nodes":[{"id":"a","name":"需求澄清","owner":"外部"}],"edges":[]}),
            "阶段「需求澄清」的负责人「外部」不在成员列表中",
        ),
        (
            json!({"nodes":[{"id":"a","owner":"外部"}],"edges":[]}),
            "阶段「a」的负责人「外部」不在成员列表中",
        ),
        (
            json!({"nodes":[{"id":"a","name":"   ","owner":"外部"}],"edges":[]}),
            "阶段「a」的负责人「外部」不在成员列表中",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[null]}),
            "流程连线格式无效",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[[]]}),
            "流程连线格式无效",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[{"from":"a","to":"missing"}]}),
            "流程连线的起点和终点必须是现有阶段",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[{"from":"missing","to":"a"}]}),
            "流程连线的起点和终点必须是现有阶段",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[{"from":"a"}]}),
            "流程连线的起点和终点必须是现有阶段",
        ),
        (
            json!({"nodes":[{"id":"a"}],"edges":[{"from":"a","to":"a"}]}),
            "流程连线不能指向自己",
        ),
        (
            json!({"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b","condition":"approved"}]}),
            "流程连线条件只支持 passed / rejected / timeout / always",
        ),
        (
            json!({"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b","condition":null}]}),
            "流程连线条件只支持 passed / rejected / timeout / always",
        ),
    ];
    for (flow, message) in cases {
        expect_rejected(&engine, &flow, message).await;
    }
}

#[tokio::test]
async fn graph_rules_reject_with_exact_messages_and_leave_room_untouched() {
    let (_dir, engine) = fixture();

    // 两个起始阶段。
    expect_rejected(
        &engine,
        &json!({"nodes":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"edges":[]}),
        "流程必须有且只有一个起始阶段",
    )
    .await;

    // 所有节点都在环上：没有起始阶段。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[{"id":"a"},{"id":"b"}],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"b","to":"a","condition":"passed"}
            ]
        }),
        "流程必须有且只有一个起始阶段",
    )
    .await;

    // 起始阶段唯一，但另一个环分量不可达：按 nodes 顺序、顿号连接。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[
                {"id":"a","name":"A阶段"},
                {"id":"b","name":"B阶段"},
                {"id":"c","name":"C阶段"},
                {"id":"d","name":"D阶段"}
            ],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"c","to":"d","condition":"passed"},
                {"from":"d","to":"c","condition":"passed"}
            ]
        }),
        "这些阶段没有连到起始阶段：C阶段、D阶段",
    )
    .await;

    // 名字缺失或为空白时用 id。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[{"id":"a"},{"id":"b"},{"id":"c","name":"   "},{"id":"d"}],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"c","to":"d","condition":"passed"},
                {"from":"d","to":"c","condition":"passed"}
            ]
        }),
        "这些阶段没有连到起始阶段：c、d",
    )
    .await;

    // 由通过边构成的循环。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[{"id":"a","name":"A"},{"id":"b","name":"B阶段"},{"id":"c","name":"C阶段"}],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"b","to":"c","condition":"passed"},
                {"from":"c","to":"b","condition":"passed"}
            ]
        }),
        "流程不能有由通过边构成的循环：B阶段 → C阶段",
    )
    .await;

    // timeout / always 也属于通过边。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}],
            "edges":[
                {"from":"a","to":"b","condition":"timeout"},
                {"from":"b","to":"c","condition":"always"},
                {"from":"c","to":"b","condition":"passed"}
            ]
        }),
        "流程不能有由通过边构成的循环：B → C",
    )
    .await;

    // rejected 回边缺少 maxLoop（缺失 / 0 都算不合法）。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[{"id":"a","name":"A阶段"},{"id":"b","name":"B阶段"},{"id":"c","name":"C阶段"}],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"b","to":"c","condition":"passed"},
                {"from":"c","to":"b","condition":"rejected"}
            ]
        }),
        "回边必须设置打回上限（maxLoop ≥ 1）：C阶段 → B阶段",
    )
    .await;
    expect_rejected(
        &engine,
        &json!({
            "nodes":[
                {"id":"a","name":"A阶段"},
                {"id":"b","name":"B阶段"},
                {"id":"c","name":"C阶段","maxLoop":0}
            ],
            "edges":[
                {"from":"a","to":"b","condition":"passed"},
                {"from":"b","to":"c","condition":"passed"},
                {"from":"c","to":"b","condition":"rejected"}
            ]
        }),
        "回边必须设置打回上限（maxLoop ≥ 1）：C阶段 → B阶段",
    )
    .await;

    // 互相打回：rejected 回边沿任意边（含另一条 rejected）回到起点，按 edges 顺序命中第一条。
    expect_rejected(
        &engine,
        &json!({
            "nodes":[
                {"id":"n1","name":"起点"},
                {"id":"a","name":"A"},
                {"id":"b","name":"B"}
            ],
            "edges":[
                {"from":"n1","to":"a","condition":"passed"},
                {"from":"a","to":"b","condition":"rejected"},
                {"from":"b","to":"a","condition":"rejected"}
            ]
        }),
        "回边必须设置打回上限（maxLoop ≥ 1）：A → B",
    )
    .await;
}

#[tokio::test]
async fn legacy_invalid_flow_stays_readable_but_cannot_be_saved_again() {
    let (_dir, engine) = fixture();
    let legacy = json!({
        "nodes":[{"id":"orphan-a","name":"孤立A"},{"id":"orphan-b","name":"孤立B"}],
        "edges":[]
    });
    engine
        .store
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE rooms SET flow_json=? WHERE id='room'",
            params![legacy.to_string()],
        )
        .unwrap();

    let (status, state) = request(&engine, "GET", "/api/rooms/room", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["room"]["flow"], legacy);
    assert_eq!(stored_flow(&engine), legacy);

    expect_rejected(&engine, &legacy, "流程必须有且只有一个起始阶段").await;
    assert_eq!(stored_flow(&engine), legacy);
}

#[tokio::test]
async fn deep_chain_flow_validates_without_recursion() {
    let (_dir, engine) = fixture();
    let chain = |back_edge: bool| {
        let mut nodes = Vec::with_capacity(5000);
        let mut edges = Vec::with_capacity(5000);
        for number in 1..=5000 {
            nodes.push(json!({
                "id": format!("n{number}"),
                "type": "phase",
                "name": format!("阶段{number}"),
                "gate": "auto",
                "outputs": [],
                "x": number % 100,
                "y": 0,
                "maxLoop": if back_edge && number == 5000 { 1 } else { 0 },
            }));
            if number < 5000 {
                edges.push(json!({
                    "from": format!("n{number}"),
                    "to": format!("n{}", number + 1),
                    "condition": "passed",
                }));
            }
        }
        if back_edge {
            edges.push(json!({"from":"n5000","to":"n2","condition":"rejected"}));
        }
        json!({"id":"flow-deep","name":"深链","nodes":nodes,"edges":edges})
    };
    save_ok(&engine, &chain(false)).await;
    assert_eq!(
        stored_flow(&engine)["nodes"].as_array().unwrap().len(),
        5000
    );
    // 深链末端一条合法 rejected 回边：环检测必须用迭代 BFS 走完整条链。
    save_ok(&engine, &chain(true)).await;
}
