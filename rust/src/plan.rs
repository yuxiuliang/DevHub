use serde_json::{Map, Value};

use crate::models::Member;

const TASK_TYPES: &[&str] = &["code", "document", "research"];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct PlanValidationError {
    pub issues: Vec<String>,
}

impl std::fmt::Display for PlanValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "计划校验失败：\n{}", self.issues.join("\n"))
    }
}

impl std::error::Error for PlanValidationError {}

fn string_list(value: Option<&Value>, label: &str, issues: &mut Vec<String>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        issues.push(format!("{}必须是非空字符串数组", label));
        return Vec::new();
    };
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            Some(text) => result.push(text.to_string()),
            None => issues.push(format!("{}必须是非空字符串数组", label)),
        }
    }
    result
}

fn normalized_task_placeholder() -> Value {
    serde_json::json!({
        "title": "",
        "spec": "",
        "owner": "",
        "type": "code",
        "acceptance": [],
        "dependsOn": [],
    })
}

/// Validate and normalize an entire plan without mutating the supplied draft.
pub fn validate_plan(
    input: &Value,
    members: &[Member],
    flow: &Value,
) -> Result<Value, PlanValidationError> {
    let Some(input_object) = input.as_object() else {
        return Err(PlanValidationError {
            issues: vec!["计划必须是 JSON 对象".to_string()],
        });
    };
    let Some(plan_tasks) = input_object.get("tasks").and_then(Value::as_array) else {
        return Err(PlanValidationError {
            issues: vec!["计划任务必须是数组".to_string()],
        });
    };
    if plan_tasks.is_empty() {
        return Err(PlanValidationError {
            issues: vec!["计划里至少要有一个任务".to_string()],
        });
    }

    let mut issues = Vec::new();
    let default_owner = members
        .iter()
        .find(|member| member.enabled != 0)
        .map(|member| member.name.as_str())
        .unwrap_or("");
    if default_owner.is_empty() {
        issues.push("当前会话没有启用成员，请先启用成员或添加成员".to_string());
    }

    let phases = flow
        .get("nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter(|node| node.get("type").and_then(Value::as_str) == Some("phase"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if input_object
        .get("summary")
        .is_some_and(|summary| !summary.is_string())
    {
        issues.push("计划摘要必须是字符串".to_string());
    }
    let decisions = string_list(input_object.get("decisions"), "计划决策", &mut issues);
    let risks = string_list(input_object.get("risks"), "计划风险", &mut issues);

    let mut normalized_tasks = Vec::with_capacity(plan_tasks.len());
    let mut dependency_edges = Vec::with_capacity(plan_tasks.len());
    for (index, task) in plan_tasks.iter().enumerate() {
        let key = format!("T{}", index + 1);
        let Some(task_object) = task.as_object() else {
            issues.push(format!("{} 必须是任务对象", key));
            normalized_tasks.push(normalized_task_placeholder());
            dependency_edges.push(Vec::new());
            continue;
        };

        let title = match task_object.get("title").and_then(Value::as_str) {
            Some(title) if !title.trim().is_empty() => title.trim().to_string(),
            _ => {
                issues.push(format!("{} 的标题不能为空，且必须是字符串", key));
                String::new()
            }
        };
        let spec = match task_object.get("spec") {
            None => String::new(),
            Some(Value::String(spec)) => spec.clone(),
            Some(_) => {
                issues.push(format!("{} 的说明必须是字符串", key));
                String::new()
            }
        };

        let owner = match task_object.get("owner") {
            None => default_owner.to_string(),
            Some(Value::String(owner)) => owner.trim().to_string(),
            Some(_) => String::new(),
        };
        let owner_matches = members
            .iter()
            .filter(|member| member.name == owner)
            .collect::<Vec<_>>();
        if owner.is_empty() || owner_matches.is_empty() {
            issues.push(format!(
                "{} 的负责人「{}」不在当前会话成员中",
                key,
                if owner.is_empty() { "未填写" } else { &owner }
            ));
        } else if owner_matches.len() > 1 {
            issues.push(format!(
                "{} 的负责人「{}」存在同名成员，请先修改成员名",
                key, owner
            ));
        } else if owner_matches[0].enabled == 0 {
            issues.push(format!(
                "{} 的负责人「{}」已停用，请换人或启用成员",
                key, owner
            ));
        }

        let task_type = match task_object.get("type") {
            None => "code",
            Some(Value::String(task_type)) if TASK_TYPES.contains(&task_type.as_str()) => {
                task_type.as_str()
            }
            Some(_) => {
                issues.push(format!("{} 的类型必须是 code、document 或 research", key));
                "code"
            }
        };

        let mut normalized_phase = None;
        if let Some(phase_value) = task_object.get("phase") {
            match phase_value.as_str() {
                Some(phase) if phase.trim().is_empty() => {}
                Some(phase) => {
                    let phase = phase.trim();
                    let matches = phases
                        .iter()
                        .filter(|candidate| {
                            candidate.get("name").and_then(Value::as_str) == Some(phase)
                        })
                        .collect::<Vec<_>>();
                    if matches.is_empty() {
                        issues.push(format!("{} 的阶段「{}」不在当前流程中", key, phase));
                    } else if matches.len() > 1 {
                        issues.push(format!(
                            "{} 的阶段「{}」存在重名，请先修改阶段名",
                            key, phase
                        ));
                    } else {
                        normalized_phase = Some(phase.to_string());
                    }
                }
                None => issues.push(format!("{} 的阶段必须是字符串", key)),
            }
        }

        let acceptance = string_list(task_object.get("acceptance"), &format!("{} 的验收标准", key), &mut issues);
        let mut depends_on = Vec::new();
        let mut valid_edges = Vec::new();
        if let Some(dependencies) = task_object.get("dependsOn") {
            match dependencies.as_array() {
                None => issues.push(format!("{} 的依赖 dependsOn 必须是从 1 开始的整数数组", key)),
                Some(dependencies) => {
                    let mut seen = std::collections::HashSet::new();
                    for dependency in dependencies {
                        let dependency = dependency
                            .as_u64()
                            .filter(|number| *number <= MAX_SAFE_INTEGER);
                        let Some(dependency) = dependency.filter(|number| *number > 0) else {
                            issues.push(format!("{} 的依赖必须是从 1 开始的正整数", key));
                            continue;
                        };
                        if dependency > plan_tasks.len() as u64 {
                            issues.push(format!("{} 依赖的任务 T{} 不存在", key, dependency));
                        } else if dependency == (index + 1) as u64 {
                            issues.push(format!("{} 不能依赖自身", key));
                        } else if !seen.insert(dependency) {
                            issues.push(format!("{} 重复依赖了 T{}", key, dependency));
                        } else {
                            let dependency_index = (dependency - 1) as usize;
                            depends_on.push(dependency);
                            valid_edges.push(dependency_index);
                        }
                    }
                }
            }
        }
        dependency_edges.push(valid_edges);

        let mut normalized = task.clone();
        let object = normalized.as_object_mut().expect("validated task object");
        object.insert("title".into(), Value::String(title));
        object.insert("spec".into(), Value::String(spec));
        object.insert("owner".into(), Value::String(owner));
        object.insert("type".into(), Value::String(task_type.to_string()));
        object.insert("acceptance".into(), serde_json::to_value(acceptance).unwrap_or(Value::Null));
        object.insert("dependsOn".into(), serde_json::to_value(depends_on).unwrap_or(Value::Null));
        if let Some(phase) = normalized_phase {
            object.insert("phase".into(), Value::String(phase));
        } else {
            object.remove("phase");
        }
        normalized_tasks.push(normalized);
    }

    let mut dependents = vec![Vec::new(); plan_tasks.len()];
    let mut pending = vec![0usize; plan_tasks.len()];
    for (task_index, dependencies) in dependency_edges.iter().enumerate() {
        pending[task_index] = dependencies.len();
        for dependency in dependencies {
            dependents[*dependency].push(task_index);
        }
    }
    let mut queue = pending
        .iter()
        .enumerate()
        .filter_map(|(index, count)| (*count == 0).then_some(index))
        .collect::<Vec<_>>();
    let mut cursor = 0;
    while cursor < queue.len() {
        for dependent in &dependents[queue[cursor]] {
            pending[*dependent] -= 1;
            if pending[*dependent] == 0 {
                queue.push(*dependent);
            }
        }
        cursor += 1;
    }
    if queue.len() != plan_tasks.len() {
        let involved = pending
            .iter()
            .enumerate()
            .filter_map(|(index, count)| (*count > 0).then(|| format!("T{}", index + 1)))
            .collect::<Vec<_>>();
        issues.push(format!(
            "任务依赖存在循环（{}），请移除循环依赖",
            involved.join("、")
        ));
    }
    if !issues.is_empty() {
        return Err(PlanValidationError { issues });
    }

    let mut normalized = input.clone();
    let object: &mut Map<String, Value> = normalized.as_object_mut().expect("plan object checked");
    object.remove("validationErrors");
    object.insert("tasks".into(), Value::Array(normalized_tasks));
    object.insert("decisions".into(), serde_json::to_value(decisions).unwrap_or(Value::Null));
    object.insert("risks".into(), serde_json::to_value(risks).unwrap_or(Value::Null));
    Ok(normalized)
}
