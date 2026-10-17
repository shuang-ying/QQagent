# QQ指令权限设置

在Web后台打开「权限」页面，在「指令权限」中分别选择范围，点击「保存指令权限」。包含help、persona、personas、memory、forget、emotion、new、topics、stats共9项；每条中英文别名共用权限。/persona的查看和切换共用权限；/topics的查看和切换共用权限。

- 管理员：admin，只允许管理员QQ。
- 全部：all，允许所有未被拉黑的用户，指令不受普通聊天的用户白名单限制。
- 白名单和管理员：whitelist，允许用户白名单QQ及管理员；白名单为空时不会放开全部用户。

黑名单、自身消息忽略、群白名单和事件去重继续生效。普通聊天仍遵循原用户白名单。管理员不必再重复加入用户白名单才能使用其获授权的指令。/memory和/forget仍只能操作关于指令发送者自己的可访问事实。

配置保存到config/app.yaml的trigger.commandPermissions字段。例如：

```yaml
trigger:
  commandPermissions:
    help: all
    persona: admin
    memory: whitelist
```

未配置的项继承commandAdminOnly/personaAdminOnly旧开关，保留已有权限；单项一旦保存优先于旧开关。面板下方「默认权限」仅影响尚未单独配置的项。保存经完整校验和原子写入后立即更新运行时；重启后仍按保存值生效。旧版本进程须重启才能加载本次新增功能，部署本身未自动启动/重启机器人。

验证：13 组专项隔离测试覆盖 9 条指令的所有权限与别名、黑名单、空白名单、群准入/去重、旧配置继承、YAML 保存及重新加载、非法提交、写失败、Web 渲染和请求。专项命令 `npm run test:command-permissions`，该回归已纳入 `npm run test:offline`，可在本地重复执行，不依赖任何历史测试记录文件。

