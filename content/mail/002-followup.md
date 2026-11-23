<!--
{"id": "mail.followup", "subject": "你收到了吗？", "from": "档案管理员 <archivist@localhost>", "reveal_after": "read:mail.welcome", "reveal_delay_ms": 8000}
-->
如果你读到了这封信，说明上一封欢迎邮件已经被系统记录为"已读"。

这封邮件是**延迟触发**的：它在你读完邮件1之后 8 秒才出现，而不是一开始就躺在收件箱里。

实现方式是 `public/nori-story-scheduler.js` 监听 `mail.read` 命令，匹配到触发器 `read:mail.welcome` 后启动计时器，到点把本邮件放行并刷新列表。

你可以把 `reveal_after` 改成别的触发器（比如 `fact:some.fact.id`），把 `reveal_delay_ms` 改成你想要的毫秒数。
