export function nowIso(): string {
  return new Date().toISOString();
}

export function currentBeijingDateContext(now = new Date()): string {
  const parts = getBeijingDateParts(now);
  return [
    `当前北京时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（${parts.weekday}）。`,
    `今天是北京时间 ${parts.year} 年 ${Number(parts.month)} 月 ${Number(parts.day)} 日。`,
    '处理“今天、明天、昨天、本周、这周、最近、当前”等相对时间时，必须以这个北京时间为唯一基准。',
    '如果搜索结果、网页摘要或来源正文里的“今天”与当前北京时间冲突，应按来源的实际发布日期或页面日期判断，并明确说明信息可能过期。'
  ].join('\n');
}

export function currentBeijingDateLabel(now = new Date()): string {
  const parts = getBeijingDateParts(now);
  return `${parts.year}-${parts.month}-${parts.day} 北京时间`;
}

export function addHoursIso(hours: number, from = new Date()): string {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function minutesAgoIso(minutes: number, from = new Date()): string {
  return new Date(from.getTime() - minutes * 60 * 1000).toISOString();
}

function getBeijingDateParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-gregory', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: parts.year ?? '0000',
    month: parts.month ?? '01',
    day: parts.day ?? '01',
    hour: parts.hour ?? '00',
    minute: parts.minute ?? '00',
    second: parts.second ?? '00',
    weekday: parts.weekday ?? ''
  };
}
