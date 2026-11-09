# 空源目录清理与恢复 / Empty source directory recovery

## 清理的边界 / Cleanup scope

移动成员的完成状态先写入日志，然后从成功移动的媒体成员（或重新整理模式中的普通文件）的 `sourceDirectories` 中收集候选目录，按从深到浅处理。根目录不在候选集合内。删除使用 `rmdir`，绝不使用递归删除；隐藏文件同样使目录非空。

The move outcome is journaled before cleanup. Candidates come only from successfully moved media, or ordinary files in reorganization mode and are processed deepest first. The root is excluded. Non-recursive `rmdir` preserves any remaining content, including hidden files.

## 目录状态 / Directory states

| State | 含义 / Meaning |
| --- | --- |
| `removing` | 删除意图已落盘 / Durable removal intent |
| `removed` | 已删除，可以依据本记录重建 / Removed; this journal authorizes recreation |
| `kept` | 非空、身份不符或其他原因而保留 / Kept because nonempty, changed, or another error |
| `restoring` | 重建意图已落盘 / Durable recreation intent |
| `restored` | 重建后的身份已落盘 / Recreated identity is durable |
| `uncertain` | 无法证明目录身份，停止自动操作 / Identity cannot be proven; stop automatic operations |

每次写入删除或重建意图后，都会再次校验扫描根目录及源目录链，再执行文件系统操作。这样可防止日志写入期间目录被换成符号链接或其他目录。文件操作仍由 Organizer 的串行队列负责。

After each intent write, the root and complete source ancestry are validated again before filesystem mutation. This guards against replacements during the journal write. Organizer's exclusive queue owns these operations.

## 重启与撤销 / Restart and undo

删除意图存在且目录已不存在时，可恢复为 `removed`；若原目录身份仍匹配则保留。`mkdir` 成功但新身份尚未落盘时发生中断，不能区分工具所建目录和外部同名目录，因此标记 `uncertain`，不猜测成功。

A removal intent plus an absent directory resolves to `removed`; a matching original directory is kept. A crash after `mkdir` but before persisting its new identity is deliberately uncertain: adopting an unrecorded same-name directory would be unsafe.

重建会改变目录 inode。日志先保存 `previousIdentity`、新身份与 `propagated: false`，再更新同根目录、同根身份的其他批次引用；最后保存传播完成。重复执行仅替换仍指向旧身份的引用，因此中途保存失败后可以恢复。

Recreation changes the inode. The journal first persists `previousIdentity`, the new identity, and `propagated: false`; references in other journals with the same root identity are updated next, and completion is persisted last. Only old-identity references are replaced, so retrying propagation is idempotent.

较早批次的源目录可能被较晚批次清理。撤销时会查找身份匹配的可信删除记录，由该记录重建目录并传播新身份，因此不要求按批次倒序撤销。外部创建的同名目录不被接管，目标或原位置冲突不被覆盖。

A later batch can remove a directory still referenced by an earlier batch. Undo consults the matching trusted removal journal to restore the shared directory and propagate its identity, allowing either undo order. Externally recreated directories are never adopted; occupied destinations are never overwritten.

## 验证 / Coverage

`test/file-type-archive.test.js` 覆盖类型建议、嵌套普通文件保留、空目录清理、隐藏文件、重启撤销、外部重建、日志写入期间替换、跨批次先撤销旧批次、身份传播写入失败、重建时符号链接替换及目标冲突。

Tests cover type suggestions, preserved nested ordinary files, cleanup, hidden files, restart/undo, external recreation, replacement during intent writes, earlier-first undo, failed identity propagation, symlink swaps during recreation, and occupied targets.
