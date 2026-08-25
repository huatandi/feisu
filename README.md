# 飞速盘点 Sanfei v4.0.0（模块化增强版）

这是基于 v3.3.38 的“等价拆分 + 稳定性增强”版本，目标是不改变核心操作习惯，同时降低单文件耦合。

## 主要增强

- HTML / CSS / JS 拆分，按职责分为 core、storage、search、table、import-export、scanner、columns、keyboard、app。
- 条码精确匹配建立 Map 索引，扫码优先 O(1) 查找；名称/前缀仍保留兼容搜索。
- CSV 改为 PapaParse 直接读取 File + `worker:true` + chunk，避免先 `FileReader.readAsText()` 把整个 CSV 装入内存。
- IndexedDB 自动保存与启动恢复，减少 Safari/PWA 被杀进程后的盘点数据丢失。
- 表格和列管理改为 DOM API 输出，避免导入数据直接拼接 `innerHTML`。
- Ctrl/Cmd + Z 支持最近 100 次单元格修改撤销。
- 删除无效的授权管理运行逻辑（原版已禁用）。
- 扫码代码独立成 scanner.js，并避免重复绑定画面点击对焦事件。

## 部署

直接部署整个目录到 GitHub Pages 即可。仍依赖原有 CDN：SheetJS、PapaParse、ZXing、Tailwind。

## 回归测试建议

1. Excel/CSV 导入 1万、1.5万、5万条。
2. EAN-13/EAN-8/UPC/CODE128 扫码。
3. 手工输入条码/编码/名称前缀搜索。
4. 数量、价格、普通列修改并刷新页面，确认自动恢复。
5. Ctrl/Cmd+Z 撤销修改。
6. 列新增、删除、排序并刷新。
7. iPhone/iPad/Android 键盘与相机扫码。
8. 导出 Excel 后重新导入核对数据完整性。
