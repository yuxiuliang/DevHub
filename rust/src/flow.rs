use serde_json::{json, Value};

struct PhaseTpl {
    name: &'static str,
    gate: &'static str,
    outputs: &'static [&'static str],
    max_loop: i64,
    reject_to: Option<usize>,
}

struct FlowTpl {
    key: &'static str,
    name: &'static str,
    desc: &'static str,
    phases: &'static [PhaseTpl],
}

static TEMPLATES: &[FlowTpl] = &[
    FlowTpl {
        key: "generic",
        name: "通用协作",
        desc: "不绑定代码：澄清 → 执行 → 评审 → 交付",
        phases: &[
            PhaseTpl {
                name: "需求澄清",
                gate: "human",
                outputs: &["brief"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "执行",
                gate: "auto",
                outputs: &["deliverable"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "评审",
                gate: "agent",
                outputs: &["review_report"],
                max_loop: 2,
                reject_to: Some(1),
            },
            PhaseTpl {
                name: "交付",
                gate: "human",
                outputs: &[],
                max_loop: 0,
                reject_to: None,
            },
        ],
    },
    FlowTpl {
        key: "code",
        name: "代码开发",
        desc: "澄清 → 方案 → 实现 → 评审 → 合并",
        phases: &[
            PhaseTpl {
                name: "需求澄清",
                gate: "human",
                outputs: &["prd"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "方案设计",
                gate: "agent",
                outputs: &["design"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "实现",
                gate: "auto",
                outputs: &["code_diff"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "评审",
                gate: "agent",
                outputs: &["review_report"],
                max_loop: 2,
                reject_to: Some(2),
            },
            PhaseTpl {
                name: "合并",
                gate: "human",
                outputs: &[],
                max_loop: 0,
                reject_to: None,
            },
        ],
    },
    FlowTpl {
        key: "document",
        name: "文档撰写",
        desc: "澄清 → 收集 → 撰写 → 评审 → 定稿",
        phases: &[
            PhaseTpl {
                name: "需求澄清",
                gate: "human",
                outputs: &["outline"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "资料收集",
                gate: "auto",
                outputs: &["sources"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "撰写",
                gate: "auto",
                outputs: &["draft"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "评审",
                gate: "agent",
                outputs: &["review_report"],
                max_loop: 2,
                reject_to: Some(2),
            },
            PhaseTpl {
                name: "定稿",
                gate: "human",
                outputs: &[],
                max_loop: 0,
                reject_to: None,
            },
        ],
    },
    FlowTpl {
        key: "research",
        name: "调研分析",
        desc: "问题定义 → 调研 → 交叉验证 → 结论",
        phases: &[
            PhaseTpl {
                name: "问题定义",
                gate: "human",
                outputs: &["question"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "调研",
                gate: "auto",
                outputs: &["findings"],
                max_loop: 0,
                reject_to: None,
            },
            PhaseTpl {
                name: "交叉验证",
                gate: "agent",
                outputs: &["verification"],
                max_loop: 2,
                reject_to: Some(1),
            },
            PhaseTpl {
                name: "结论",
                gate: "human",
                outputs: &[],
                max_loop: 0,
                reject_to: None,
            },
        ],
    },
    FlowTpl {
        key: "blank",
        name: "空白流程",
        desc: "从零开始画，一个阶段都不预置",
        phases: &[],
    },
];

fn template(key: &str) -> Option<&'static FlowTpl> {
    TEMPLATES.iter().find(|t| t.key == key)
}

fn build_flow(key: &str) -> Option<Value> {
    let tpl = template(key)?;
    let mut nodes = Vec::new();
    for (i, p) in tpl.phases.iter().enumerate() {
        nodes.push(json!({
            "id": format!("n{}", i + 1),
            "type": "phase",
            "name": p.name,
            "owner": "",
            "gate": p.gate,
            "outputs": p.outputs,
            "x": 40 + (i as i64) * 230,
            "y": 90 + if i % 2 == 0 { 0 } else { 40 },
            "maxLoop": p.max_loop,
        }));
    }
    let mut edges = Vec::new();
    for i in 0..nodes.len().saturating_sub(1) {
        edges.push(json!({ "from": format!("n{}", i + 1), "to": format!("n{}", i + 2), "condition": "passed" }));
    }
    for (i, p) in tpl.phases.iter().enumerate() {
        if let Some(to) = p.reject_to {
            if to < nodes.len() {
                edges.push(json!({ "from": format!("n{}", i + 1), "to": format!("n{}", to + 1), "condition": "rejected" }));
            }
        }
    }
    Some(json!({
        "id": format!("flow-{}", key),
        "name": tpl.name,
        "template": key,
        "nodes": nodes,
        "edges": edges,
    }))
}

pub fn flow_template_list() -> Vec<Value> {
    TEMPLATES
        .iter()
        .map(|t| {
            json!({
                "key": t.key,
                "name": t.name,
                "desc": t.desc,
                "phases": t.phases.iter().map(|p| p.name).collect::<Vec<_>>(),
            })
        })
        .collect()
}

pub fn starter_flow(key: &str) -> Option<Value> {
    build_flow(key)
}

pub fn default_flow() -> Value {
    build_flow("generic").expect("generic flow template")
}
