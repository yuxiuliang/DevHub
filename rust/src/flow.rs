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

const NODE_GATES: &[&str] = &["auto", "agent", "human"];
const EDGE_CONDITIONS: &[&str] = &["passed", "rejected", "timeout", "always"];

fn node_label<'a>(node: &'a Value, id: &'a str) -> &'a str {
    // 与 Node 侧 flowNodeName 对齐：名字为空白或缺失时用 id，否则保留原样（不 trim）。
    node.get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(id)
}

fn loop_limit(node: &Value) -> i64 {
    node.get("maxLoop")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
        })
        .unwrap_or(0)
}

fn integer_in_range(value: &Value, low: i64, high: i64) -> bool {
    if let Some(number) = value.as_i64() {
        return (low..=high).contains(&number);
    }
    // Node 侧用 Number.isInteger 判定，1.0 这类整数值的浮点写法同样算整数。
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && number >= low as f64 && number <= high as f64
    })
}

/// 从 `from` 沿 `next` 中的边能否到达 `target`（显式队列，深图不递归）。
fn reaches(next: &[Vec<usize>], from: usize, target: usize) -> bool {
    if from == target {
        return true;
    }
    let mut seen = vec![false; next.len()];
    seen[from] = true;
    let mut queue = std::collections::VecDeque::from([from]);
    while let Some(node) = queue.pop_front() {
        for &child in &next[node] {
            if child == target {
                return true;
            }
            if !seen[child] {
                seen[child] = true;
                queue.push_back(child);
            }
        }
    }
    false
}

/// 迭代版 Kosaraju，返回每个节点的强连通分量编号（深图不递归）。
fn strongly_connected_components(next: &[Vec<usize>]) -> Vec<usize> {
    let count = next.len();
    let mut previous: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (from, targets) in next.iter().enumerate() {
        for &to in targets {
            previous[to].push(from);
        }
    }
    let mut visited = vec![false; count];
    let mut order = Vec::with_capacity(count);
    for root in 0..count {
        if visited[root] {
            continue;
        }
        visited[root] = true;
        let mut stack = vec![(root, 0usize)];
        while let Some(&(node, cursor)) = stack.last() {
            if cursor < next[node].len() {
                stack.last_mut().unwrap().1 += 1;
                let child = next[node][cursor];
                if !visited[child] {
                    visited[child] = true;
                    stack.push((child, 0));
                }
            } else {
                order.push(node);
                stack.pop();
            }
        }
    }
    let mut components = vec![usize::MAX; count];
    let mut component = 0usize;
    for &root in order.iter().rev() {
        if components[root] != usize::MAX {
            continue;
        }
        components[root] = component;
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            for &parent in &previous[node] {
                if components[parent] == usize::MAX {
                    components[parent] = component;
                    stack.push(parent);
                }
            }
        }
        component += 1;
    }
    components
}

fn invalid(message: impl Into<String>) -> crate::settings::SettingsError {
    crate::settings::SettingsError::bad_request(message)
}

/// 保存流程前的服务端校验：结构 → 图结构。`member_names` 需包含停用成员。
///
/// 环检测把 `rejected` 边当作回边：其余条件（passed / timeout / always）构成"通过边"。
/// 一条边成环指：非 rejected 边两端在同一通过边强连通分量里；rejected 边则要求
/// 从 `to` 沿任意边（含 rejected）能回到 `from`，上限挂在发起打回的 `from` 节点上。
/// 因此模板里的「评审 → 执行」rejected 回边合法，而由 passed 边构成的循环会被拒绝。
pub fn validate_flow(
    flow: &Value,
    member_names: &[String],
) -> Result<(), crate::settings::SettingsError> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let flow = flow.as_object().ok_or_else(|| invalid("流程必须是对象"))?;
    let nodes = flow
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("流程阶段必须是数组"))?;
    let edges = flow
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("流程连线必须是数组"))?;
    let member_names: HashSet<&str> = member_names.iter().map(String::as_str).collect();

    let mut ids = HashSet::new();
    let mut node_ids = Vec::with_capacity(nodes.len());
    let mut labels = Vec::with_capacity(nodes.len());
    for node in nodes {
        let object = node
            .as_object()
            .ok_or_else(|| invalid("流程阶段格式无效"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| invalid("流程阶段必须有有效标识"))?;
        if !ids.insert(id) {
            return Err(invalid(format!("流程阶段标识重复：{id}")));
        }
        if let Some(outputs) = object.get("outputs") {
            if !outputs
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err(invalid("流程阶段产出必须是文字标签列表"));
            }
        }
        for axis in ["x", "y"] {
            if let Some(value) = object.get(axis) {
                if !value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
                    return Err(invalid(format!("流程阶段位置 {axis} 必须是有限的非负数")));
                }
            }
        }
        if let Some(kind) = object.get("type") {
            if kind.as_str() != Some("phase") {
                return Err(invalid("流程阶段类型只支持 phase"));
            }
        }
        if let Some(gate) = object.get("gate") {
            if !gate.as_str().is_some_and(|gate| NODE_GATES.contains(&gate)) {
                return Err(invalid("流程阶段完成条件只支持 auto / agent / human"));
            }
        }
        if let Some(limit) = object.get("maxLoop") {
            if !integer_in_range(limit, 0, 9) {
                return Err(invalid("回边上限必须是 0-9 的整数"));
            }
        }
        if let Some(owner) = object.get("owner") {
            let owner = owner
                .as_str()
                .ok_or_else(|| invalid("流程阶段负责人必须是成员名字"))?;
            if !owner.is_empty() && !member_names.contains(owner) {
                return Err(invalid(format!(
                    "阶段「{}」的负责人「{owner}」不在成员列表中",
                    node_label(node, id)
                )));
            }
        }
        node_ids.push(id);
        labels.push(node_label(node, id));
    }

    struct EdgeRef<'a> {
        from: &'a str,
        to: &'a str,
        condition: Option<&'a str>,
    }
    let mut edge_refs = Vec::with_capacity(edges.len());
    for edge in edges {
        let object = edge
            .as_object()
            .ok_or_else(|| invalid("流程连线格式无效"))?;
        let (Some(from), Some(to)) = (
            object.get("from").and_then(Value::as_str),
            object.get("to").and_then(Value::as_str),
        ) else {
            return Err(invalid("流程连线的起点和终点必须是现有阶段"));
        };
        if !ids.contains(from) || !ids.contains(to) {
            return Err(invalid("流程连线的起点和终点必须是现有阶段"));
        }
        if from == to {
            return Err(invalid("流程连线不能指向自己"));
        }
        if let Some(value) = object.get("condition") {
            if !value
                .as_str()
                .is_some_and(|condition| EDGE_CONDITIONS.contains(&condition))
            {
                return Err(invalid(
                    "流程连线条件只支持 passed / rejected / timeout / always",
                ));
            }
        }
        edge_refs.push(EdgeRef {
            from,
            to,
            condition: object.get("condition").and_then(Value::as_str),
        });
    }

    if nodes.is_empty() {
        return Ok(());
    }

    let index: HashMap<&str, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(position, id)| (*id, position))
        .collect();
    let mut incoming = vec![0usize; nodes.len()];
    let mut next_all: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut next_through: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut edge_ends = Vec::with_capacity(edge_refs.len());
    for edge in &edge_refs {
        let from = index[edge.from];
        let to = index[edge.to];
        incoming[to] += 1;
        next_all[from].push(to);
        if edge.condition != Some("rejected") {
            next_through[from].push(to);
        }
        edge_ends.push((from, to));
    }

    let starts = incoming.iter().filter(|&&degree| degree == 0).count();
    if starts != 1 {
        return Err(invalid("流程必须有且只有一个起始阶段"));
    }
    let start = incoming.iter().position(|&degree| degree == 0).unwrap();
    let mut seen = vec![false; nodes.len()];
    seen[start] = true;
    let mut queue = VecDeque::from([start]);
    while let Some(node) = queue.pop_front() {
        for &next in &next_all[node] {
            if !seen[next] {
                seen[next] = true;
                queue.push_back(next);
            }
        }
    }
    let unreachable: Vec<&str> = (0..nodes.len())
        .filter(|&node| !seen[node])
        .map(|node| labels[node])
        .collect();
    if !unreachable.is_empty() {
        return Err(invalid(format!(
            "这些阶段没有连到起始阶段：{}",
            unreachable.join("、")
        )));
    }

    let components = strongly_connected_components(&next_through);
    for (position, edge) in edge_refs.iter().enumerate() {
        let (from, to) = edge_ends[position];
        let rejected = edge.condition == Some("rejected");
        let on_cycle = if rejected {
            // 刻意不对称：rejected 回边只要求「这条边闭合成环」，环上其余边条件不限
            // （含另一条 rejected，例如 A --rejected--> B 与 B --rejected--> A 互相打回），
            // 所以这里用全部边做 BFS。非 rejected 边仍只认"通过边"构成的环，否则默认模板的
            // 执行 --passed--> 评审 + 评审 --rejected--> 执行 会被误判成通过边循环。
            reaches(&next_all, to, from)
        } else {
            components[from] == components[to]
        };
        if !on_cycle {
            continue;
        }
        if rejected {
            if loop_limit(&nodes[from]) < 1 {
                return Err(invalid(format!(
                    "回边必须设置打回上限（maxLoop ≥ 1）：{} → {}",
                    labels[from], labels[to]
                )));
            }
        } else {
            return Err(invalid(format!(
                "流程不能有由通过边构成的循环：{} → {}",
                labels[from], labels[to]
            )));
        }
    }
    Ok(())
}

pub fn default_flow() -> Value {
    build_flow("generic").expect("generic flow template")
}
