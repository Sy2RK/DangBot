const highRiskPatterns = [
  /批量(发送|群发|转发)/i,
  /(导出|转发).*(聊天记录|群聊|隐私|通讯录)/i,
  /(访问|读取).*(敏感|私密|机密)/i,
  /(调用|发送到|上传到).*(外部|第三方|公网)/i,
  /(大文件|压缩包|超过|全量)/i,
  /(违法|绕过|破解|攻击|钓鱼|骚扰)/i
];

const refusalPatterns = [
  /(垃圾营销|骚扰|批量加群|自动加好友)/i,
  /(盗号|木马|恶意软件|窃取密码|绕过平台规则)/i,
  /(人肉|未经授权的信息收集)/i
];

export function isHighRiskPrompt(prompt: string): boolean {
  return highRiskPatterns.some((pattern) => pattern.test(prompt));
}

export function shouldRefusePrompt(prompt: string): boolean {
  return refusalPatterns.some((pattern) => pattern.test(prompt));
}

export function refusalMessage(): string {
  return '这个请求可能涉及滥用、越权或违规风险，我不能执行。可以换成合规、明确授权的处理需求。';
}
