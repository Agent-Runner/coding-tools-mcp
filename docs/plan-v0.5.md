# v0.5.0 执行计划（可靠性迭代）

**状态：** 计划文档，未开始写功能代码。
**核验基线：** `main` @ `b079994`（0.3.0 已发布；`coding_tools_mcp/` 自 `ed85e41` 起未变）。
**本文档中每一个 file:line 引用都在 `b079994` 上重新核验过，并附有锚文本。**

> **行号会漂移。** 参考材料曾因针对 0.2.2 撰写而整体偏移约 +129 行，付出过真实代价。
> 执行任何一条前，先用 `grep -n` 按锚文本确认位置；锚文本是权威，行号只是提示。

本计划整合了两份参考材料（v0.5.0 可靠性交接文档、`apply_changes` 设计评审及后续讨论），
并逐条对照当前代码核验。**两份材料中有相当一部分诊断已经过时**——最严重的一批 bug
（EOF 换行保真、Unicode 行边界静默损坏、空 context 行拒绝）已在 0.3.0（`d09e902`）落地修复。
过时结论的完整清单见第 2 节；不要按参考材料原文重做已完成的工作。

背景、动机与遥测基线不在此复述：0.3.0 已修复项见 [CHANGELOG.md](../CHANGELOG.md) 与
[migration-0.3.md](migration-0.3.md)；遥测口径见 [telemetry.md](telemetry.md)。

---

## 1. 目标

用户反馈的核心问题是"服务器极其健忘、一个小改动耗掉一上午"。根因不是模型遗忘，
而是服务器交给模型会静默失效的句柄与状态，且错误面无法表达"此调用永远不会成功，停止重试"。
0.3.0 解决了句柄与传输层的大头；v0.5.0 收尾剩余两块：

1. `apply_patch` 的恢复协议（遥测中占比最大的错误族，970 条 / 28.9%）。
2. 无法度量"代码是否真的改对了"的遥测（失败构建被计为成功、循环指标测错对象）。

同时新增结构化编辑工具 `apply_changes`，并把高风险的 workspace 写策略收敛到开关后面。

---

## 2. 核验结论：参考材料哪些已过时

### 2.1 已在 0.3.0 落地、不要重做的项

以下各项均已实证核验（含运行验证，见第 6 节），参考材料中把它们当作待办的段落全部作废：

| 参考材料中的说法 | 当前代码事实 |
| --- | --- |
| "`splitlines()` 在 8 种 Unicode 行边界上过度切分、任何 patch 都会静默损坏文件中部；应作为第一个 PR 单独落地" | **已修复**（`d09e902`）。`apply_update_hunks` 使用 `split("\n")`，`patching.py:345`，注释明确说明双射性质。实测 form feed / U+2028 / NEL 全部原样保留。 |
| "`had_trailing_newline` 从原文件抓取并无条件盖回，patch 无法改变 EOF 换行数；42 种组合中 16 种失败；V4A 需要格式决策（`*** End of File` 语义或 `\ No newline` 标记）才能修" | **已修复，且无需格式决策**。`had_trailing_newline` 已不存在；实测整文件替换的 16 种 EOF 尾部组合 0 失败。讨论材料"A1 决策"整节已完成。 |
| "空 context 行写成 `""` 是硬失败" | **已修复**。`parse_update_hunk` 接受 `""`（`patching.py:406-410`，锚文本 "V4A spells an empty context line as a single space"）。 |
| "HTTP 传输下每次 `initialize` 创建独立 runtime，两个 MCP session 就是两把锁、两份 baseline map" | **前提已死**。0.3.0 起 HTTP 无状态、一个 runtime 拥有 workspace，`patch_lock` 只有一把（`server.py:1337`）。契约 [runtime-contract-v0.3.md](runtime-contract-v0.3.md) "Workspace and patch guarantees" 一节已声明锁跨全部客户端。仍然成立的残余问题是**跨进程**（两个服务器进程指向同一 workspace），见 Track D。 |
| "工具数确实是 20 个" | 现为 **18 个**（`TOOL_REGISTRY`，`server.py:570-697`；`get_default_cwd`/`set_default_cwd` 已删除）。 |
| "`request_permissions` 在 `server.py:3268-3280`" 等一批行号 | 已漂移。当前锚点：`request_permissions` 处理器 `server.py:3397`，`ELICITATION_UNSUPPORTED` 在 `:3419`；`MAX_HTTP_REQUEST_BYTES = 1_048_576` 在 `:195`；空 changes 报错 `"No files were modified."` 在 `:2321`；`read_file` 在 `:1727`；`write_generated_or_ignored` 仅出现于 schema `:4745` 与 `SECURITY.md`；非 git 仓库 diff fallback（`patch_baselines`）在 `:3186-3211`。 |
| 交接文档附录 repro 脚本"@@ scope anchor 用例应 FAIL" | **该用例按附录原文写法实际会 PASS**：它的 context 行含唯一的 `def greet(name):`，不依赖锚点即可唯一定位。C2 缺陷本身真实存在，但复现形状必须是"`@@ <scope>` 锚点 + 本身不唯一的 context"。已用修正形状实证：`PATCH_CONTEXT_AMBIGUOUS: matched 2 locations`。修正后的脚本见附录。 |
| "E1：把 yield 时间与进程生命周期分离" | **已经是分离的**。`yield_time_ms`（默认 10000，`server.py:2362`）与 `timeout_ms`（默认 30000，`server.py:2361`）是两个参数。剩余问题是默认生命周期太短：已让出（后台化）的命令仍会在 `timeout_ms` 截止时被 SIGTERM（`processes.py` `refresh_status`，锚文本 `terminate_process_group(self.process, signal.SIGTERM)`）。v0.5.0 的工作是调默认值，不是补机制。 |
| "`scripts/repro_patch_failures.py`（附录）……保留该脚本" | 该脚本**不在仓库中**（`scripts/` 下没有）。Track A 第一个 PR 要以修正后的用例集重建它。 |

### 2.2 核验为仍然成立的关键事实

| 事实 | 锚点（`b079994`） |
| --- | --- |
| `@@ <scope>` 锚文本被解析后直接丢弃，无法参与消歧 | `patching.py:319-325`，`if lines[i].startswith("@@")` 只用于切分 hunk |
| 仅精确行相等匹配；一处行尾空格即 `PATCH_CONTEXT_NOT_FOUND` | `patching.py:426` `find_subsequence_all`；已实证复现 |
| 成功结果无任何 post-edit 证据 | `server.py:2324-2332` 结果字段；`tool_results.py:172` `_render_patch`（"Patch applied to 1 file (+3 -1)"） |
| 无 already-applied 检测、无幂等键 | 无实现 |
| `apply_patch` 是唯一直接写入口 | `project_context.py:52`，"Use apply_patch as the only direct file-modification tool" |
| 非零退出码被记为成功的工具调用 | `processes.py:280` 硬编码 `"ok": True`；`server.py:1703-1705` 以 payload 的 `ok` 上报遥测 |
| `consecutive_failures` 是单个全局槽位，任意工具的任意成功都清零；且 0.3.0 起是跨客户端 runtime 级 | `telemetry.py:400-408`；`SessionTelemetry` docstring（`telemetry.py:281-290`） |
| 18 个工具共用一个只声明 `ok`/`error` 的输出 schema | `server.py:4438` `tool_output_schema` |
| `request_permissions` 始终在 `tools/list` 且标注 `read_only=True`，非 dangerous 模式下无条件返回 `ELICITATION_UNSUPPORTED` | ToolSpec `server.py:684-688`；处理器 `:3397-3425` |
| `git_diff` 永远不含 untracked 文件 | `server.py:3153-3156`，只有 `git diff` 与 `--cached` |
| 命令默认 30s 生命周期、上限 600s | `server.py:2361`；schema 默认 `:4644` |
| `StagedFile.content: str \| None`，`None` 隐式编码"删除"；无"只校验不写"状态 | `patching.py:78-84`；`commit()` 按 `change.content is not None` 判断（`:107`） |
| 同路径链式累积是无测试、无契约承诺的实现细节 | `server.py:2267`、`:2277-2281`（`prior = staged.get(...)`）；已扫描 `tests/` 全部 patch envelope：**零**个重复路径用例，契约对 chaining 只字未提 |
| 提交器已按 resolved Path 去重 | `patching.py:172-176` `_assert_unique_paths`；`apply_patch` 更早用 `staged` dict 按 display 去重 |
| 路径校验在 planner 层（staging 之前） | `server.py:2242-2249`，`reject_write_symlink` + `resolve_for_write` |
| `read_file` 三次触文件：`stat()`、4096 字节二进制嗅探、流式文本读；流式读用 `newline=""` + `errors="strict"`，逐行遍历全文件且从不 break | `server.py:1745-1768` |
| Landlock 给 workspace 完整写权限；`landlock_write_roots()` 只额外返回 `[runtime_dir]` | `server.py:4136-4143`（`workspace_access = handled`）；`:1455-1456` |
| `write_generated_or_ignored` 只存在于 schema，从未被 raise | `server.py:4745`；另见 `SECURITY.md` |
| 完成命令的输出保留 TTL 为 300s | `server.py:199` `COMPLETED_COMMAND_TTL_SECONDS = 300` |
| SWE-bench 仍是 preflight/placeholder | [swe-bench.md](swe-bench.md)，"Default local smoke conclusion: `PREFLIGHT_ONLY`" |
| `limitations.md` 未披露精确匹配、唯一性要求、输出保留过期 | [limitations.md](limitations.md) |

### 2.3 当前 repro 基线

用附录脚本（修正版）在 `b079994` 上运行的实际结果：

```
OK      | blank context line written as empty string
OK      | blank context line written as a single space
FAIL    | @@ scope anchor as sole disambiguator      -> PATCH_CONTEXT_AMBIGUOUS
OK      | unified-diff @@ -1,4 +1,4 @@ header
FAIL    | context line with one trailing space       -> PATCH_CONTEXT_NOT_FOUND
FAIL    | @@ anchor selecting the second occurrence  -> PATCH_CONTEXT_AMBIGUOUS
EOF fidelity failures: 0/16
unicode form feed / U+2028 / NEL: all preserved
```

三个 FAIL 就是 C2（两例）与 C4（一例）。Track A 完成后六例必须全 OK，EOF 与 Unicode
组合保持 0 失败。

---

## 3. 仍然开放的问题清单（编号沿用交接文档）

| ID | 问题 | 归属 Track |
| --- | --- | --- |
| C2 | `@@ <scope>` 锚被丢弃，无法消歧；越懂 V4A（Codex 方言）的模型错得越多 | A |
| C4 | 仅精确行相等；无空白/缩进容错降级 | A |
| C1 | `apply_patch` 描述过薄：无唯一性要求、无 `@@` 语义、无空行规则 | A |
| C5 | 失败无修复数据：缺失败 hunk 附近的当前文本与候选位置（`retry_hint` 与 `hunk_index` 已有） | A |
| C6 | 成功无 post-edit 证据，模型对文件状态的信念纯靠记忆 | A |
| C7 | 无 already-applied 检测；丢失响应后重放会重复应用或失败 | A |
| C8 | `apply_patch` 是唯一写原语，卡住的模型没有备选 | B |
| B2 | 无重复失败断路器 | C |
| B3 | `request_permissions` 是必然失败却始终被广告的工具 | C |
| D1 | 非零退出计为成功，仪表盘对失败构建全盲 | C |
| D2 | 失败连击是全局单槽、被任意成功清零、跨客户端 | C |
| D4 | 无 per-tool 输出 schema | C |
| E1 | 默认 30s 生命周期杀死后台化的安装/构建/测试 | D |
| E2 | `git_diff` 不含 untracked，模型无法核验刚 `*** Add File` 的文件 | D |
| C3-契约 | `patch_lock` 只保护单进程内并发这一事实未写进契约 | D |
| F2 | `limitations.md` 缺 C2/C4/A2 行为披露 | D |
| F1 | 基准不测真实编码能力 | F |

---

## 4. 执行计划

四个 Track，外加开关后置项与评估。**Track A 最先做**：`apply_patch` 是今天产生 970 条
错误的现役工具，而 `apply_changes` 是模型还要学习的新表面。Track D 可与 Track A 并行。
Track C 中 D1/D2 尽早落地——验收门槛依赖修正后的度量。

依赖关系：

```
A1 → A2 → A3 → A4 → A5        （A5 的 revision 字段是 B3 的共享词汇）
B1 → B3；B2 → B3 → B4
C1、C2 独立；C3 依赖 C1/C2 的度量；C4 独立
D1、D2、D3 全部独立，可并行
E1 依赖决策 D-3；F1 排在 B3 之后、E1 默认值讨论之前
```

### Track A：完成 `apply_patch` 恢复协议（最先做）

改动集中在 `patching.py` 与 `tool_results.py`，是风险最低、体量最大的收益。

**A1 — 重建回归护栏。** 按附录（修正版）恢复 `scripts/repro_patch_failures.py`，
退出码等于失败用例数，接入 CI。这是本类 bug 最便宜的回归守卫，且必须先于行为改动
存在，才能证明后续 PR 的效果。

**A2 — C2：让 `@@ <scope>` 参与定位。** 解析器保留每个 hunk 的锚文本
（`parse_patch` 内部结构变化，wire 不变）；匹配时先在文件中定位锚文本行，
把候选窗口限制到锚点之后最近的区域；仍然多解才报 `PATCH_CONTEXT_AMBIGUOUS`。
锚文本匹配建议：先精确整行，再前缀/去空白降级（与 A3 的降级阶梯共用词汇）。
验收：附录用例 3、6 转 OK；用例 6 必须命中**第二处**出现（`def farewell` 分支）。

**A3 — C4：分级匹配。** 阶梯固定为：精确 → 忽略行尾空白 → 忽略行首缩进宽度 → 失败。
每次降级必须在结果中如实标注（`warnings` + `details.match_quality`），绝不静默降级。
验收：附录用例 5 转 OK 且结果带降级标注；精确匹配路径的行为与性能不变。

**A4 — C1 + C5：描述与失败数据。** 工具描述补齐唯一性要求、`@@` 语义、空行规则
（当前描述只有一行示例，`server.py:607-614`）。失败时在 `details` 中加入：失败 hunk
附近的当前文本（带行号）与候选匹配位置。注意：改 `ToolSpec.description` 会改
`tools/list` 输出，`tests/compliance/test_tool_golden.py` 等 golden 必须同 PR 更新。

**A5 — C6 + C7：成功证据与重放安全。** 成功结果的 `affected_files` 每项增加
changed line ranges 与 post-edit 内容哈希（字段名 `revision`，与 `apply_changes`
共用词汇；additive wire 变更，归属明确在本 PR）；`_render_patch` 在文本中附上紧凑证据。
C7 做 already-applied 检测（整个 patch 的 old 态不存在且 new 态已在盘上时给出独立结果，
语义见决策 D-5）。注：`apply_patch` 加 `revision` 字段是**报告**不是**校验**——它不做
revision 校验，V4A 的 hunk context 本身就是内容级 stale 保护，比全文件 revision 更精细
（无关处的改动不会导致拒绝）。这个区别要写进契约，否则会误导。

### Track B：`apply_changes` 结构化编辑工具

设计评审的五个核心决策全部采纳：保留 `apply_patch` 并新增 `apply_changes`、
第一版即支持 multi-file、用全文件 `revision` 而非 Hashline、共用提交内核、
structured-only 只作为可选强模式。

**B1 — `read_file` 输出 `revision`。** 采用**流式增量哈希**：`read_file` 已经无条件
逐行遍历全文件（需要 `total_lines`，从不 break，`server.py:1758-1768`），在既有循环里
`digest.update(line.encode("utf-8"))` 即可。字节精确性成立：`errors="strict"` 保证合法
UTF-8，`newline=""` 保留原始行尾，逐行再编码可复原原字节（BOM 以 `\ufeff` 往返）。
收益：零额外 `open()`（现有三次触文件不增加）、O(1) 内存、**彻底删掉**
`MAX_REVISION_BYTES`、`revision: null` 返回和"传 null 确认"路径；哈希与模型看到的内容
出自同一趟流，TOCTOU 窗口为零——这正是 revision 要防的失败。同 PR 改 `tool_results.py`
`_render_read_file`（`tool_results.py:98`）把 `revision=` 放进模型可见文本。

**B2 — 提交器加显式 action。** `StagedFile` 增加 `action: "write" | "delete" | "verify"`,
替换 `content is None` 的隐式编码（`patching.py:82`、`:107`）。`verify` 参与全部
baseline 断言但从不写盘——`copy` 需要它校验源文件未变。这是提交器 API 变更（内部，
无 wire 变化），不要按"零改动"排期；不需要新提交器这一判断仍然成立。

**B3 — `apply_changes` 工具本体。** 要点（多数已由核验钉死，仅决策 D-1/D-4 待拍板）：

- 文件级 op：`create`（目标必须不存在，不接受 `revision`）、`write`（upsert，存在时
  `revision` 必填，见 D-4）、`edit`（行范围操作）、`delete`、`move`、`copy`。
- `edit` 子操作含 `replace` / `insert_before` / `insert_after` / 行删除。
  `insert_before` 与 `insert_after` 数学等价但**都保留**——off-by-one 是模型高频错误，
  两种拼法能显著降错，planner 里一行归一化。边界值必须写进 schema description：
  `insert_after: 0` 表示插到文件头，`insert_before: total_lines + 1` 表示追加到尾。
- `content` 用**整行语义**：按 `split("\n")` 切行、整体替换目标范围；
  **`content: ""` 必须特判为零行（删除该范围）**——`"".split("\n")` 是 `[""]`（一个空行）
  不是 `[]`，不特判会静默错一行。schema description 写明
  "content should not end with a newline; a trailing newline produces an extra blank line"。
- 声明式语义：同一路径在一次调用中至多出现一次，违者 `PATCH_PATH_CONFLICT`
  （错误信息覆盖所有同路径重复，不只 Delete→Add；与 `apply_patch` 的统一见决策 D-2）。
- 路径校验在 planner、staging 之前：每个 `path` 与 `destination` 过
  `reject_write_symlink` + `resolve_for_write`（对齐 `server.py:2242-2249`），不下沉到提交器。
- 空 `changes` 数组：与 `apply_patch` 一致，`PATCH_FAILED "No files were modified."`
  （`server.py:2321`）。
- 大小约束：保留计数上限（100 changes × 100 edits，防病态输入），但文档明确
  `MAX_HTTP_REQUEST_BYTES = 1_048_576`（`server.py:195`）才是绑定约束，超限走 HTTP 413
  （现行行为，不是工具错误）；给模型的经验值写"单次调用建议不超过约 20 个文件"。
- 结果结构与 A5 后的 `apply_patch` 同形（`affected_files` 带
  `previous_revision`/`revision`），但契约写明两者保护机制不同且各自完整：
  patch 用内容锚点，changes 用 revision。字段形似不代表语义等价。
- `revision` 不匹配 → `CHANGE_REVISION_MISMATCH`，retryable，附当前 revision 与
  重读指引。

**B4 — 指令与文档。** `project_context.py:52` 的项目指令改为
"prefer `apply_changes` / `apply_patch`；do not modify files through `exec_command`"；
更新 [tools-and-schemas.md](tools-and-schemas.md) 与契约。工具目录 18 → 19，
golden 同步更新。

### Track C：断路器与遥测（没有它就无法证明 v0.5.0 有效）

**C1 — D1：拆分操作结果维度。** 协议层 `ok` 的语义不变（非零退出仍是**成功的工具调用**），
新增遥测维度记录操作结果：`exited_0` / `exited_nonzero` / `timeout` / `signal` /
`spawn_error`（数据源自 `processes.py` payload 已有的 `exit_code` / `timed_out` /
`signal` 字段）。仪表盘由此把五件事分开：工具调用失败、策略拒绝、逻辑操作失败、
最终恢复率、任务验证失败。

**C2 — D2：失败连击按 `(tool, error_code)` 记账。** 用 map 替换单槽
（`telemetry.py:311`、`:400-408`），只有**同类成功**清除同类连击，容量设上限。
0.3.0 把槽位改成 runtime 级对单任务循环检测是倒退，在此修正。

**C3 — B2：断路器。** 指纹 = `(tool, error_code, 规范化参数哈希)`；同一指纹的
**确定性**失败（`retryable=false` 或 validation 类）第二次出现后，第三次逐字重试
直接返回不可重试的 `REPEATED_FAILURE`，错误文本给出改变方案的指引。瞬态类
（conflict/runtime，`retryable=true`）永不熔断。协议里没有 task 身份，指纹按
runtime 级记账即可——被拦截的只是逐字相同的重试，跨客户端拦截它同样正确。

**C4 — B3 + D4：目录诚实化。** 对不能做 elicitation 的场景不再广告
`request_permissions`（默认目录 18 → 17；dangerous 模式保留）。同 PR 落 D4：
按工具声明输出 schema（`command_id`、`next_action`、`output_ref`、`truncated`、
`status`、`exit_code` 等字段进 schema）。两者都动 `tools/list`，golden 与
schema-drift 测试同步更新，合并成一次目录变更。

### Track D：低风险纯收益（与 Track A 并行）

**D1 — E1：命令生命周期默认值。** `timeout_ms` 默认 30000 → 120000
（`server.py:2361` 与 schema `:4644`；上限 600000 不动，`yield_time_ms` 默认不动）。
机制已存在，只调默认值；2 CPU / 4 GB 沙箱里安装/构建/测试常规超过 30s。

**D2 — E2：`git_diff` 纳入 untracked。** `git ls-files --others --exclude-standard`
枚举后按 `/dev/null` 基线合成 new-file diff；加 `include_untracked` 参数，默认 true
（与 `git_status` 的 `include_untracked` 默认一致，`server.py:4690`）。

**D3 — 披露三件套。**
- C3-契约：在 [runtime-contract-v0.3.md](runtime-contract-v0.3.md) 明确
  "`patch_lock` 只保护同一进程内的并发；跨进程（两个服务器指向一个 workspace）的
  安全完全依赖提交前的 baseline 复检"。0.3.0 宣传多客户端共享一个 workspace 服务器，
  用户更容易误推"跨进程也安全"，措辞按**进程**写，不按 session 写。诚实成本为零。
- `server_info` 暴露 `workspace_mutation_policy` 与 `workspace_mutation_enforcement`；
  `check_exec_environment` 对非 Linux 明确警告"静态命令扫描无法证明任意程序的副作用"。
- F2：`limitations.md` 披露：匹配语义（Track A 后为分级匹配及其阶梯）、hunk 唯一性
  要求、输出保留 300s TTL 与过期行为。

### Track E：开关后置，v0.5.0 不默认开启

**E1 — `--workspace-mutation=structured-only` + `--exec-write-path`。** 默认
`unrestricted`（现状）。硬约束已核验：Landlock 是 path-beneath 前缀模型、allow-only
无 deny 规则，"可写目录但拒绝其中某些文件"不可表达（规则技术上可绑定单个文件，
但对源码树不可行），只能做"只读 + 目录 allowlist"。allowlist 会撞上三类问题，
必须在文档里全部写明：构建目录（每个工具链都要加）、`.git`（任何 `git commit` 直接
失败）、`__pycache__`（散落源码树各处、运行时动态创建；预创建在技术上可行但需要给
每个包目录枚举并在加包时重做，**操作上**不可持续）。`write_paths` 用启动参数而非
运行时授权：现在不存在任何授权机制（`server.py:3397` 无条件 unsupported），运行时
授权是从零建 elicitation + grant 存储 + TTL + scope + 审计的大工程，且构建输出目录
是项目属性不是单次请求属性。同 PR **删除** `write_generated_or_ignored` enum 值
（`server.py:4745`）而不是给它补实现——留着它暗示有个没做完的功能。
默认开启与否见决策 D-3；0.3.0 刚发布七个破坏性变更，默认开会同时打爆
pytest、npm、cargo、gradle 和 git。

### Track F：真实评估（F1）

30–50 个真实任务，同模型同提示词，原生工具 vs 本服务器，评分维度：最终测试通过率、
首个 patch 成功率、到 green 的轮数、引入的回归数、墙钟时间。这是唯一能证伪
"折腾一整天还是不对"、也是唯一能证明 v0.5.0 有效的东西。**排序：在 Track B 落地之后、
Track E 任何默认值切换讨论之前**——先证明 `apply_changes` 确实能替代 shell 编辑，
再考虑锁 exec，否则可能先锁死 exec 再发现新工具首次成功率不如 patch。
现有 dogfood / Aider 跑法多为提交预制 patch，只证明机械链路；SWE-bench 现状见
[swe-bench.md](swe-bench.md)。

---

## 5. 验收门槛

在 D1/D2 修正后的遥测管线上度量（**不要用当前仪表盘**——它把失败构建计为成功、
循环指标测的是错误累计而非连续失败）：

| 指标 | 基线（0.2.2） | v0.5.0 目标 |
| --- | --- | --- |
| `write_stdin` 失败率 | 84.3% | < 10% |
| `read_output` 失败率 | 58.2% | < 10% |
| `request_permissions` 失败率 | 59.9% | n/a——默认不再广告 |
| `apply_patch` 失败率 | 14.4% | < 5% |
| 首次尝试 patch 成功率 | 未度量 | 先建立度量，然后 > 80% |
| 同一确定性错误重复 3+ 次 | 存在 | 0（断路器保证） |
| 从未关闭的 session | 26% | < 5% |
| 总失败率 | 7.32% | < 3% |

回归护栏：附录 repro 脚本 6/6 通过、EOF 16 组合 0 失败、Unicode 边界 0 损坏，接入 CI。

---

## 6. 复现与再核验

本文档第 2.3 节的基线输出由附录脚本产生，无任何依赖：

```bash
python3 scripts/repro_patch_failures.py
```

Track A 期间发现新的失败形状时向脚本追加用例；退出码即失败数，CI 可直接 gate。

---

## 7. 待拍板的决策

以下决策无法仅凭最佳实践单方面确定，需要 owner 拍板。每条附影响分析与推荐选项。

### D-1：`apply_changes` 的 `revision` 必填还是选填？

这是整个设计里最不对称的决策：先严后松是兼容变更，先松后严是破坏性变更。

- **选填的实际后果：** 模型省 token 的本能一定会让它省掉 `revision`，退化成
  search/replace 级保护；契约只能写"如果模型提供了……"。会得到第二个
  `write_generated_or_ignored`——schema 里有、实际没人用。
- **必填的实际成本比想象小：** `create` 不接受该字段（文件不存在），零成本；
  `edit`/`delete`/`move`/`copy` 针对已有文件，模型本来就要先读才知道改什么；
  唯一多出的一轮是"刚 create 完立刻 edit 同一文件"，该场景本身说明第一次没写对，罕见。
- **本仓库先例：** 0.3.0 删除 `default_cwd` 就是为了消灭"会变陈旧的隐藏状态"；
  选填 `revision` 重新引入同类 bug。

**推荐：`edit`/`delete`/`move`/`copy`（及 `write` 作用于已存在文件时）必填；`create`
不接受该字段。** 逃生口不放 wire 上（模型能选就一定一律选逃生口），放服务器启动参数
`--allow-unversioned-changes`，默认关闭，由操作者决定。
连带确认：`apply_patch` **不加** revision 校验——hunk context 是内容级 stale 保护，
比全文件 revision 更好（无关改动不误拒）；两个入口保护机制不同但各自完整，写进契约。

### D-2：是否移除 `apply_patch` 的同路径链式累积，统一为声明式？

已核验：链式累积（`server.py:2267`、`:2277-2281`）是零测试覆盖、零契约承诺的实现
细节泄漏；V4A 原版也不允许一个文件在一个 patch 中出现两次。顺序语义让 `dry_run`
预测、错误归因、并发推理全变复杂，收益只是"可以把两个 hunk 拆成两个 Update File 段"
——而这本来就该合并成一个 hunk 列表。

**推荐：统一声明式，两个入口共用同一 planner；同路径重复报
`PATCH_PATH_CONFLICT`（覆盖 Delete→Add 在内的所有组合），错误信息给出合并指引。**
唯一能翻转此决策的是存在真实下游消费者（benchmark harness、集成）依赖链式行为——
这个知识在维护者手里，不在仓库里。请在动手前确认一次。

### D-3：`--workspace-mutation=structured-only` 默认开还是关？

- **默认关（开关后置）：** 愿意付配置代价的用户先开；跑完 Track F 摸清真实需要的
  `write_paths` 后再讨论切默认。代价是"structured-only 是真正内核强制"这个卖点打折。
- **默认开：** 在还没有 `write_paths` 授权流程的版本里，同时打爆 pytest、npm、cargo、
  gradle、git；紧跟一个已含七个破坏性变更的 release，是复合风险。

**推荐：默认关。** 把它作为"可用的强模式"来卖，而不是默认值。等 Track F 的数据
（`apply_changes` 首次成功率 ≥ patch，且 exec 写路径清单收敛）再评估切默认。

### D-4：`replace_all` 留在 edit 子操作，还是提为文件级 `write` op？

现设计把它当 edit 子操作，结果不得不特判"不能与其他 edit 混用"——特判本身就是信号：
它不需要 `start_line`/`end_line`，是文件级操作穿了 edit 的外衣。

**推荐：提为文件级 `write`（upsert：不存在则创建、存在则整体替换且 `revision` 必填），
同时保留 `create`。** 不用 `write` 吃掉 `create`：`create` 的价值是"我断言这是新文件"
的意图声明，合并后"我以为不存在但其实存在"会静默覆盖，违反"不允许静默覆盖"的自身
原则。顺带给"想彻底替换 a.py"一个不绕 delete+create 禁令的自然答案。代价是文件级 op
从 5 个变 6 个，`edit` 概念反而更纯粹。两种方案都能工作，此条优先级低。

### D-5：already-applied 检测命中时，返回错误还是幂等成功？

场景：响应丢失后模型重放同一 patch，或模型对已改好的文件再次提交同一修改。
检测条件：整个 patch 的 old 态在盘上已不存在、且 new 态已精确在位。

- **方案 (a) 幂等成功**（`ok: true` + `already_applied: true` + post-state revision）：
  对丢失响应重放是正确语义（at-most-once 效果，报告现状），模型无需额外推理。
  风险：检测是启发式的，可能掩盖"模型在改一个碰巧已长成目标形状的错误文件"。
- **方案 (b) 独立错误**（`PATCH_ALREADY_APPLIED`，`retryable: false`，附 post-state
  revision）：显式、强迫模型确认现状后再继续；B1 之后的错误文本足以让模型正确处理。
  风险：把一次本可透明吸收的重放变成一次需要推理的错误。

**推荐：(b)。** 在没有真正幂等键存储的前提下，启发式检测配"如实报告 + 不可重试"
更安全；错误 details 携带 post-state revision 让模型一步确认。若后续为 `apply_changes`
引入显式幂等键，可在键匹配时升级为 (a) 的语义。

### D-6：`timeout_ms` 新默认值取 120s 还是 300s？

30s 明确过短（安装/构建/测试在 2 CPU / 4 GB 沙箱常规超时）。120s 覆盖绝大多数
构建/测试步骤且失控命令的最坏挂起时间可控；300s 对 monorepo 级构建更友好但拉长
每次失控命令的代价。上限 600s 不变，模型可按需上调。

**推荐：120s。** 配合 Track A/C 的错误恢复改进，超时后模型能以更高的 `timeout_ms`
低成本重试；取 300s 的理由需要 Track F 的真实任务数据支撑。

---

## 8. 交接注意事项

- **AGENTS.md 规则 2**（一事一处）：本文档链接 `CHANGELOG.md`、`migration-0.3.md`、
  `limitations.md`、`runtime-contract-v0.3.md`、`telemetry.md`、`swe-bench.md`
  而不复述它们，保持这样。
- **patch 格式名为 V4A**，代码注释使用该名称；查 `@@` scope 语义的先例时以此为关键词。
- **每个逻辑变更一个 PR**，目录变更（A4、B4、C4）必须与 golden/schema-drift 测试
  同 PR 更新，否则 CI 红。
- 本计划落笔时**未写任何功能代码**；第 3 节全部是带核验锚点的诊断。

---

## 附录：`scripts/repro_patch_failures.py`（修正版）

相对交接文档附录的修正：用例 3 改为真正依赖 `@@ <scope>` 锚点消歧的形状（原形状的
context 自身唯一，不触发 C2），新增用例 6（用锚点选择第二处出现）与 EOF/Unicode
保真检查（守住 0.3.0 已修复的行为）。保存到 `scripts/repro_patch_failures.py` 并
`chmod +x`；脚本从自身位置推导仓库根（`parents[1]`），只有放在根目录下一级才能正确
导入 `coding_tools_mcp`。

```python
#!/usr/bin/env python3
"""Exercise the patch shapes models emit most often against apply_update_hunks.

Regression guard for the apply_patch recovery work tracked in
docs/plan-v0.5.md. Every case is a shape real model output produces; a FAIL
means the server rejects a patch a competent model would write. The EOF and
Unicode checks guard behavior already fixed in 0.3.0 (d09e902).

Run with no dependencies:

    python3 scripts/repro_patch_failures.py

At b079994 three cases fail (the discarded ``@@ <scope>`` anchor, twice, and
exact-match intolerance of trailing whitespace). When track A lands, all cases
must pass. Exit status is the number of failing cases, so CI can gate on it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.patching import apply_update_hunks, parse_patch


# Two identical bodies, so a hunk that relies on a discarded ``@@ <scope>``
# anchor becomes ambiguous rather than merely wrong.
FILE = '''def greet(name):
    print("hi")

    return name

def farewell(name):
    print("hi")

    return name
'''


CASES: list[tuple[str, str]] = [
    (
        "blank context line written as empty string",
        '''*** Begin Patch
*** Update File: a.py
@@
 def greet(name):
-    print("hi")
+    print(f"hi {name}")

     return name
*** End Patch''',
    ),
    (
        "blank context line written as a single space",
        '''*** Begin Patch
*** Update File: a.py
@@
 def greet(name):
-    print("hi")
+    print(f"hi {name}")
 
     return name
*** End Patch''',
    ),
    (
        "@@ scope anchor as sole disambiguator",
        '''*** Begin Patch
*** Update File: a.py
@@ def greet
-    print("hi")
+    print(f"hi {name}")
*** End Patch''',
    ),
    (
        "unified-diff @@ -1,4 +1,4 @@ header",
        '''*** Begin Patch
*** Update File: a.py
@@ -1,4 +1,4 @@
 def greet(name):
-    print("hi")
+    print(f"hi {name}")
*** End Patch''',
    ),
    (
        "context line with one trailing space",
        '''*** Begin Patch
*** Update File: a.py
@@
 def greet(name): 
-    print("hi")
+    print(f"hi {name}")
*** End Patch''',
    ),
    (
        "@@ anchor selecting the second occurrence",
        '''*** Begin Patch
*** Update File: a.py
@@ def farewell
-    print("hi")
+    print("bye")
*** End Patch''',
    ),
]


def attempt(label: str, patch: str) -> bool:
    try:
        for op in parse_patch(patch):
            if op.kind == "update":
                apply_update_hunks(FILE, op.hunks, op.path)
    except ToolFailure as exc:
        print(f"FAIL    | {label}\n          -> {exc.code}: {exc.message}")
        return False
    except Exception as exc:  # noqa: BLE001 - a crash is a distinct signal
        print(f"CRASH   | {label} -> {type(exc).__name__}: {exc}")
        return False
    print(f"OK      | {label}")
    return True


def eof_fidelity_failures() -> int:
    """Whole-file replacements across EOF-newline combos must be byte-exact."""

    import itertools

    failures = 0
    tails = ["", "\n", "\n\n", "\n\n\n"]
    for src_tail, want_tail in itertools.product(tails, repeat=2):
        src = "line1\nline2" + src_tail
        want = "line1\nline2" + want_tail
        hunk = ["-" + l for l in src.split("\n")] + ["+" + l for l in want.split("\n")]
        try:
            got = apply_update_hunks(src, [hunk], "t.txt")
        except ToolFailure as exc:
            failures += 1
            print(f"EOF-ERROR src={src!r} want={want!r} -> {exc.code}")
            continue
        if got != want:
            failures += 1
            print(f"EOF-MISMATCH src={src!r} want={want!r} got={got!r}")
    print(f"EOF fidelity failures: {failures}/16")
    return failures


def unicode_boundary_failures() -> int:
    """A patch touching one line must not rewrite \\x0c, U+2028, or NEL elsewhere."""

    failures = 0
    for name, content in [
        ("form feed", "a\n\x0cb\nc\n"),
        ("U+2028", "a\nx\u2028y\n"),
        ("NEL", "a\nx\x85y\n"),
    ]:
        got = apply_update_hunks(content, [["-a", "+A"]], "t.txt")
        expect = content.replace("a\n", "A\n", 1)
        ok = got == expect
        failures += not ok
        print(f"unicode {name}: {'ok' if ok else 'CORRUPTED ' + repr(got)}")
    return failures


def main() -> int:
    failures = sum(not attempt(label, patch) for label, patch in CASES)
    failures += eof_fidelity_failures()
    failures += unicode_boundary_failures()
    print(f"\nfailures: {failures}")
    if failures:
        print("See docs/plan-v0.5.md sections 3 and 4 (track A).")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
```
