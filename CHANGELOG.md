# Changelog

本文件记录 ThinCoder CLI 的发布历史。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.12.14] - 2026-08-10

- **修复** 小终端 permission 面板挤出输入框（layout 溢出补偿新增 permission 压缩）
- **修复** iTerm2 Ctrl+C 键盘协议序列泄漏（stdin 剥离未处理的 CSI u 序列）
- **修复** eng 模式 advisor token 正则错配（改用完整 token 构建正则，与 prompt 格式一致）
- **修复** 输入框 ↑ 键历史导航草稿丢失（进入/编辑历史模式时扩容草稿保护）
- **重构** key-handler 拆分搜索模块（key-handler-search.mjs）
- **文档** 架构文档计数/模块/状态同步更新

## [0.12.13] - 2026-08-08

评审机制全面重构（用户驱动的三轮决策）：

- **prior 硬解析移除**：收敛轮注入上一轮评审的完整原文（模型直接理解），删除表头匹配与 all-clear 短语两类"字符串解析 LLM 输出"的脆弱机制
- **评审触发范围收缩**：评审只跟代码修改绑定——bash/git 等副作用工具不再触发多余评审轮（评审后读日志/清理临时文件不再要求重复评审）
- **AGENTS.md 文档地图**：需求基线声明（REQUIREMENTS.md + 设计文档 + 对话背景）+ docs/design/ 27 份文档分组清单，评审者按地图定位需求文档
- **项目根发现**：多项目工作区从评审范围定位子项目 AGENTS.md（工作区元地图不遮蔽）；修复混合路径分隔符误判
- **收敛体共享模块**：round 2+ 消息构建单一来源；空回复/纯工具输出不再冒充评审记录

## [0.12.12] - 2026-08-07

- advisor 记录按真实时序落盘（timeline）、markdown 表格 render-before-measure 对齐修复（含 heading 多行/双重粗体）、requirements 兜底、评审结论可用性提示
- 双线消息历史（人读线 + 机读线）、压缩只作用于机读线、机读消息不进人读线
- 临时文件（tmp-*）不触发 advisor guard；config.mjs 加固（spec 预排序、providers 守卫、saveConfig 写副本）
- VS Code 扩展发布准备（marketplace 元数据、.vscodeignore、vscode-mock 依赖修复）

## [0.12.11] - 2026-08-05

- subagent 按类型配置模型（`/submodel` + `subagentModels`）
- 可配置 bash shell（`/shell platform` 切换）
- 其他稳定性与体验改进

## [0.12.10] - 2026-08-05

- 代码质量梳理：清理未使用的导出、advisor 计时器与静态导入修复、复评不再因旧会话数据误报

## [0.12.9] - 2026-08-04

- 提示词体系质量梳理：移除工程模式与 advisor 的冲突、交付评审语义修正

## [0.12.8] - 2026-08-04

- pending-task 推回最多触发一次（消除无界完成循环）

## [0.12.7] - 2026-08-03

- 折叠可读性修复（主输出/思考永不折叠）、窄终端宽表格裁剪

## [0.12.6] - 2026-08-02

- checkpoint v2、git 破坏性命令保护、鼠标支持、长消息折叠、bash 行为约束

## [0.12.5] - 2026-08-01

- 行内代码下划线样式

## [0.12.4] - 2026-08-01

- 压缩统一规范、Kimi For Coding、Ctrl+C 双重确认、空响应重试、markdown 渲染修复

## [0.12.3] 及更早

v0.12.x 早期版本、v0.11.x、v0.8.x、v0.7.x 与 v0.2–v0.6 系列——完整历史见 [git 提交记录](https://gitee.com/shanghai-xinbo/thincoder/commits/main)。
