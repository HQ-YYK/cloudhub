export function recoveryCodeText(username: string, display: string, generatedAt = new Date()): string {
  const date = generatedAt.toISOString().slice(0, 10)
  return [
    'CloudHub 恢复码',
    `用户名：${username}`,
    `生成日期：${date}`,
    '',
    display,
    '',
    '恢复码是忘记密码后找回文件的唯一方式。请把它存进密码管理器或打印出来，不要截图发给别人。',
  ].join('\n')
}
