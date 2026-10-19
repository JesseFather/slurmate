# 测试夹具

这里的插件树只给测试用。它们不进安装包，也不是开发样例 —— 基座不依赖任何具体
插件，所以基座的能力测试挂在一棵最小的 web 插件上。

- `plugins/web-demo/`：一个有界面、会登录、有作业侧的 web 插件。客户端测试会
  替换它的作业侧（见 `boot.test.mjs` 与 `integration.mjs`），集群测试直接跑
  这一份。

真集群上分发的插件是独立项目，契约见 [`packer/docs/README.md`](../../packer/docs/README.md)。
