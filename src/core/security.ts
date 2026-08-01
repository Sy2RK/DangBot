const refusalPatterns = [
  /(垃圾营销|骚扰|批量加群|自动加好友)/i,
  /(盗号|木马|恶意软件|窃取密码|绕过平台规则)/i,
  /(人肉|未经授权的信息收集)/i
];

export function shouldRefusePrompt(prompt: string): boolean {
  return refusalPatterns.some((pattern) => pattern.test(prompt));
}

export function refusalMessage(): string {
  return '这个请求可能涉及滥用、越权或违规风险，我不能执行。可以换成合规、明确授权的处理需求。';
}
