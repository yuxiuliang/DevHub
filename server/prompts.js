export function buildPlanPrompt({ room, members, flow, decisions }) {
  const memberLines = members
    .map((m) => `- ${m.name}｜worker=${m.worker}｜角色=${m.role_name || '未命名'}｜职责=${m.role_brief || '未填写'}`)
    .join('\n');
  const phaseLines = flow.nodes
    .filter((n) => n.type === 'phase')
    .map((n, i) => `${i + 1}. ${n.name}（门禁：${n.gate}${n.owner ? `，建议负责人：${n.owner}` : ''}）`)
    .join('\n');
  const decisionLines = decisions.length
    ? decisions.map((d) => `- ${d.text}`).join('\n')
    : '- （暂无）';

  return `# 任务：为一次需求生成执行计划

你是本次协作的计划者。请只输出 JSON，不要输出任何解释、不要使用 Markdown 代码块。

## 房间
- 名称：${room.name}
- 需求：${room.requirement}
- 仓库：${room.repo_path}
- 基准分支：${room.base_branch}

## 成员
${memberLines || '- （暂无成员）'}

## 流程阶段
${phaseLines || '- （无）'}

## 已生效的决策
${decisionLines}

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
`;
}

export function buildTaskPrompt({ room, task, member, decisions, upstream, feedback, worktree }) {
  // 计划里的 spec 常带原始仓库绝对路径。执行者实际在独立 worktree 里工作，
  // 这里把路径统一映射过去，避免 agent 顺手改到主仓库或别的任务目录。
  const wt = worktree || room.repo_path;
  const inWt = (s) => String(s || '').split(room.repo_path).join(wt);
  const decisionLines = decisions.length
    ? decisions.map((d) => `- ${d.text}${d.rationale ? `（${d.rationale}）` : ''}`).join('\n')
    : '- （暂无）';
  const upstreamLines = upstream.length
    ? upstream.map((u) => `### ${u.key} ${u.title}\n${inWt((u.summary || '（无摘要）').slice(0, 3000))}`).join('\n\n')
    : '（无）';
  const acceptance = (task.acceptance || []).length
    ? task.acceptance.map((a) => `- ${a}`).join('\n')
    : '- 按任务说明完成，并自行验证';

  return `# 任务：${task.title}

你是本次协作中的一名执行者。

## 你的角色
- 名字：${member.name}
- 角色：${member.role_name || '未命名'}
- 职责：${member.role_brief || '按任务说明执行'}

## 房间背景
- 房间：${room.name}
- 总目标：${inWt(room.requirement)}

## 当前任务
- 类型：${task.type}
- 编号：${task.key}
- 说明：
${inWt(task.spec) || '（无详细说明，请根据标题和验收标准执行）'}

## 验收标准
${acceptance}

## 上游产出
${upstreamLines}

## 已生效的决策
${decisionLines}

${feedback ? `## 上一轮评审意见（必须逐条处理）\n${feedback}\n` : ''}
## 工作目录
你当前的工作目录就是本任务的独立工作区（git worktree）：${wt}
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
`;
}

export function buildReviewPrompt({ room, task, member, diff, acceptance, worktree }) {
  const wt = worktree || task.worktree || room.repo_path;
  const inWt = (s) => String(s || '').split(room.repo_path).join(wt);
  return `# 任务：评审一个改动

你是本次协作中的评审者。

## 你的角色
- 名字：${member.name}
- 角色：${member.role_name || '未命名'}
- 职责：${member.role_brief || '严格评审，只指出阻塞问题'}

## 房间背景
- 房间：${room.name}
- 总目标：${inWt(room.requirement)}

## 被评审的任务
- 编号：${task.key}
- 标题：${task.title}
- 说明：${inWt(task.spec) || '（无）'}
- 验收标准：
${(acceptance || []).map((a) => `- ${a}`).join('\n') || '- （无）'}

## 改动内容（git diff）
\`\`\`diff
${diff.slice(0, 60000)}
\`\`\`

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
`;
}

export function buildExpandPrompt({ room, task }) {
  return `# 任务：补充一个模糊的任务说明

房间目标：${room.name}｜${room.requirement}
任务：${task.key} ${task.title}
现有说明：${task.spec || '（空）'}

请把任务说明补充成一段自包含、可执行的 spec，包含：目标、边界、涉及文件、验收标准。
只输出补充后的说明正文，不要输出其他内容。`;
}
