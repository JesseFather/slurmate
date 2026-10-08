# `plugins/` —— 两棵开发样例

这个目录里放着**两棵开发样例树**，用来在开发时对齐插件两侧的能力。
**一个插件都不装是合法状态** —— 基座两端都不依赖它们，客户端打包也不含它们。

样例树本身不是给插件作者读的文档。**写插件要读的东西在
[`packer/docs/README.md`](../packer/docs/README.md)**（目录形状、清单的每个键、
作业侧钩子、打包命令），契约是
[`packer/docs/PLUGIN-SPEC.md`](../packer/docs/PLUGIN-SPEC.md)。
