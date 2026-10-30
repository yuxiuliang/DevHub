use serde_json::Value;

use crate::models::{Decision, Member, Room, Task};

fn fill(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("{{{{{}}}}}", key), value);
    }
    out
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn role(m: &Member) -> &str {
    if m.role_name.trim().is_empty() {
        "未命名"
    } else {
        &m.role_name
    }
}

fn brief(m: &Member) -> &str {
    if m.role_brief.trim().is_empty() {
        "未填写"
    } else {
        &m.role_brief
    }
}

pub fn build_plan_prompt(
    room: &Room,
    members: &[Member],
    flow: &Value,
    decisions: &[Decision],
) -> String {
    let member_lines = members
        .iter()
        .map(|m| {
            format!(
                "- {}｜worker={}｜角色={}｜职责={}",
                m.name,
                m.worker,
                role(m),
                brief(m)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let phase_lines = flow
        .get("nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| n.get("type").and_then(Value::as_str) == Some("phase"))
                .enumerate()
                .map(|(i, n)| {
                    let name = n
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名阶段");
                    let gate = n.get("gate").and_then(Value::as_str).unwrap_or("auto");
                    let owner = n.get("owner").and_then(Value::as_str).unwrap_or("");
                    if owner.is_empty() {
                        format!("{}. {}（门禁：{}）", i + 1, name, gate)
                    } else {
                        format!(
                            "{}. {}（门禁：{}，建议负责人：{}）",
                            i + 1,
                            name,
                            gate,
                            owner
                        )
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let decision_lines = if decisions.is_empty() {
        "- （暂无）".to_string()
    } else {
        decisions
            .iter()
            .map(|d| format!("- {}", d.text))
            .collect::<Vec<_>>()
            .join("\n")
    };

    fill(
        r#"# 任务：为一次需求生成执行计划

你是本次协作的计划者。请只输出 JSON，不要输出任何解释、不要使用 Markdown 代码块。

## 房间
- 名称：{{room_name}}
- 需求：{{requirement}}
- 仓库：{{repo_path}}
- 基准分支：{{base_branch}}

## 成员
{{members}}

## 流程阶段
{{phases}}

## 已生效的决策
{{decisions}}

## 输出格式（严格遵守）
{
  "summary": "一句话说明这次计划怎么拆",
  "tasks": [
    {
      "title": "简短标题",
      "spec": "自包含的任务说明：要做什么、边界在哪、涉及哪些文件或目录、验收标准是什么",
      "type": "code | document | research",
      "owner": "成员名字，必须与上面成员列表完全一致",
      "phase": "对应上面某个阶段名，可省略",
      "acceptance": ["可验证的验收条件"],
      "dependsOn": [1]
    }
  ],
  "decisions": ["需要在房间内长期生效的决策，可省略"],
  "risks": ["风险提示，可省略"]
}

## 约束
- 任务数量 1 到 6 个，宁可少而清晰。
- 每个任务只能有一个 owner，owner 必须是上面列出的成员名字之一。
- dependsOn 用任务序号（从 1 开始），表示必须先完成的任务。
- 涉及改代码的任务 type 用 code；产出文档用 document；只调研不改动用 research。
- spec 必须自包含：执行者看不到本段对话，只能看到 spec。
- 不要臆造仓库里不存在的文件；不确定时先留出探索空间。
- 如果需求本身不清晰，把它拆成一个"澄清需求"的 research 任务，而不是编造细节。
"#,
        &[
            ("room_name", room.name.clone()),
            ("requirement", room.requirement.clone()),
            ("repo_path", room.repo_path.clone()),
            ("base_branch", room.base_branch.clone()),
            (
                "members",
                if member_lines.is_empty() {
                    "- （暂无成员）".to_string()
                } else {
                    member_lines
                },
            ),
            (
                "phases",
                if phase_lines.is_empty() {
                    "- （无）".to_string()
                } else {
                    phase_lines
                },
            ),
            ("decisions", decision_lines),
        ],
    )
}

pub fn build_task_prompt(
    room: &Room,
    task: &Task,
    member: &Member,
    decisions: &[Decision],
    upstream: &[Task],
    feedback: &str,
    worktree: &str,
) -> String {
    let wt = if worktree.is_empty() {
        room.repo_path.as_str()
    } else {
        worktree
    };
    let in_wt = |s: &str| s.replace(&room.repo_path, wt);
    let decision_lines = if decisions.is_empty() {
        "- （暂无）".to_string()
    } else {
        decisions
            .iter()
            .map(|d| {
                if d.rationale.is_empty() {
                    format!("- {}", d.text)
                } else {
                    format!("- {}（{}）", d.text, d.rationale)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let upstream_lines = if upstream.is_empty() {
        "（无）".to_string()
    } else {
        upstream
            .iter()
            .map(|u| {
                format!(
                    "### {} {}\n{}",
                    u.key,
                    u.title,
                    in_wt(&truncate_chars(
                        if u.summary.is_empty() {
                            "（无摘要）"
                        } else {
                            &u.summary
                        },
                        3000
                    ))
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let acceptance =
        if task.acceptance_json.trim().is_empty() || task.acceptance_json.trim() == "[]" {
            "- 按任务说明完成，并自行验证".to_string()
        } else {
            serde_json::from_str::<Value>(&task.acceptance_json)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .map(|arr| {
                    arr.iter()
                        .map(|a| format!("- {}", a.as_str().unwrap_or("")))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_else(|| "- 按任务说明完成，并自行验证".to_string())
        };

    fill(
        r#"# 任务：{{title}}

你是本次协作中的一名执行者。

## 你的角色
- 名字：{{member_name}}
- 角色：{{role_name}}
- 职责：{{role_brief}}

## 房间背景
- 房间：{{room_name}}
- 总目标：{{requirement}}

## 当前任务
- 类型：{{task_type}}
- 编号：{{task_key}}
- 说明：
{{spec}}

## 验收标准
{{acceptance}}

## 上游产出
{{upstream}}

## 已生效的决策
{{decisions}}

{{feedback_section}}
## 工作目录
你当前的工作目录就是本任务的独立工作区（git worktree）：{{worktree}}
任务说明里的仓库路径已映射到该目录。所有读写、测试和提交都只能发生在这个目录内；
不要读写原始仓库目录或其他任务的 worktree。

## 要求
1. 先阅读工作目录里已有的代码和文档，再动手。
2. 只做本任务范围内的事，不要顺手重构无关代码。
3. 完成后自己验证：能跑测试就跑测试，能跑类型检查就跑。
4. 把改动提交到当前分支（git add -A && git commit）。不要切换分支，不要合并到主分支。
5. 不要修改工作目录之外的文件。
6. 如果任务无法完成，说明卡在哪里，不要假装完成。

## 输出格式（最后必须包含这几节）
## 结果
一句话说明做完了什么。

## 改动
列出改动的文件，以及每个文件改了什么。

## 验证
你执行了哪些验证，结果如何。没验证就写"未验证"并说明原因。

## 未决问题
没有就写"无"。
"#,
        &[
            ("title", task.title.clone()),
            ("member_name", member.name.clone()),
            (
                "role_name",
                if member.role_name.trim().is_empty() {
                    "未命名".to_string()
                } else {
                    member.role_name.clone()
                },
            ),
            (
                "role_brief",
                if member.role_brief.trim().is_empty() {
                    "按任务说明执行".to_string()
                } else {
                    member.role_brief.clone()
                },
            ),
            ("room_name", room.name.clone()),
            ("requirement", in_wt(&room.requirement)),
            ("task_type", task.task_type.clone()),
            ("task_key", task.key.clone()),
            (
                "spec",
                if task.spec.trim().is_empty() {
                    "（无详细说明，请根据标题和验收标准执行）".to_string()
                } else {
                    in_wt(&task.spec)
                },
            ),
            ("acceptance", acceptance),
            ("upstream", upstream_lines),
            ("decisions", decision_lines),
            (
                "feedback_section",
                if feedback.is_empty() {
                    String::new()
                } else {
                    format!("## 上一轮评审意见（必须逐条处理）\n{}\n", feedback)
                },
            ),
            ("worktree", wt.to_string()),
        ],
    )
}

pub fn build_review_prompt(
    room: &Room,
    task: &Task,
    member: &Member,
    diff: &str,
    acceptance: &[String],
    worktree: &str,
) -> String {
    let wt = if worktree.is_empty() {
        task.worktree.as_str()
    } else {
        worktree
    };
    let in_wt = |s: &str| s.replace(&room.repo_path, wt);
    let acceptance_lines = if acceptance.is_empty() {
        "- （无）".to_string()
    } else {
        acceptance
            .iter()
            .map(|a| format!("- {}", a))
            .collect::<Vec<_>>()
            .join("\n")
    };
    fill(
        r#"# 任务：评审一个改动

你是本次协作中的评审者。

## 你的角色
- 名字：{{member_name}}
- 角色：{{role_name}}
- 职责：{{role_brief}}

## 房间背景
- 房间：{{room_name}}
- 总目标：{{requirement}}

## 被评审的任务
- 编号：{{task_key}}
- 标题：{{title}}
- 说明：{{spec}}
- 验收标准：
{{acceptance}}

## 改动内容（git diff）
```diff
{{diff}}
```

## 评审纪律
- 你只做只读评审：禁止创建、修改、删除、暂存或提交任何文件，禁止切换分支、stash、reset。
- 可以运行只读命令（读文件、看 diff、跑测试），但测试也不能改动仓库内容。
- 你评审的是上面给出的 diff 和当前工作区状态，不要先把改动“应用”到别处再评审。

## 输出格式（严格遵守，只输出 JSON，不要代码块）
{
  "verdict": "approve | request_changes",
  "blocking": [
    {"file": "路径", "line": 0, "issue": "问题", "suggestion": "怎么改"}
  ],
  "notes": "总体评价，一两句话"
}

## 判定标准
- 只在有明确阻塞问题时才 request_changes。
- 风格偏好、可以后续优化的点放到 notes，不要放 blocking。
- 阻塞问题必须具体到文件和行，并给出可执行的修改建议。
- 不要因为"可以更好"就阻塞。
"#,
        &[
            ("member_name", member.name.clone()),
            (
                "role_name",
                if member.role_name.trim().is_empty() {
                    "未命名".to_string()
                } else {
                    member.role_name.clone()
                },
            ),
            (
                "role_brief",
                if member.role_brief.trim().is_empty() {
                    "严格评审，只指出阻塞问题".to_string()
                } else {
                    member.role_brief.clone()
                },
            ),
            ("room_name", room.name.clone()),
            ("requirement", in_wt(&room.requirement)),
            ("task_key", task.key.clone()),
            ("title", task.title.clone()),
            (
                "spec",
                if task.spec.trim().is_empty() {
                    "（无）".to_string()
                } else {
                    in_wt(&task.spec)
                },
            ),
            ("acceptance", acceptance_lines),
            ("diff", truncate_chars(diff, 60000)),
        ],
    )
}
