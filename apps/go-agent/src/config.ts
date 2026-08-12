import type { GoConfig } from './types.js';

export function createDefaultConfig(): GoConfig {
  return {
    keyword: '',
    defaultKeywords: ['完成', '已完成', '以上就是', 'task_complete', '结束', '全部完成', '【任务完成】'],
    maxRounds: 10,
    pollMinMs: 4000,
    pollMaxMs: 9000,
    finishConfirmMs: 4000,
    idleThresholdMs: 30000,
    busyStallMs: 180000,
    cooldownMinMs: 40000,
    cooldownMaxMs: 90000,
    charMinMs: 40,
    charMaxMs: 180,
    bridgeFailureStopCount: 5,
    nudgePool: [
      '请继续推进当前任务，不要停下来。',
      '接着完成剩余部分，保持当前质量水平。',
      '请继续按你的思路把下一步做完。',
      '任务尚未完成，请继续往下推进。',
      '请把当前方案补充完整，覆盖关键细节。',
      '请继续完善实现，包括边界情况和异常处理。',
      '请补全缺失的部分，并保持前后逻辑一致。',
      '请检查刚才的产出，找出错误或遗漏并修正。',
      '请对已完成部分做一次自检：逻辑是否严谨、结论是否有依据。',
      '请回顾任务目标，确认没有遗漏的需求。',
      '请把当前成果整理成清晰的交付格式，方便我验收。',
      '请总结当前进度，并说明下一步计划。',
      '请给出阶段性结论：已完成什么、还缺什么、下一步做什么。',
      '请主动审视任务中的风险、边界和潜在问题，并继续处理。',
      '如果信息不足或遇到阻碍，请说明并给出替代方案，然后继续。',
      '请站在验收者视角检查产出是否达标，不达标就继续修正。',
      '请继续直到任务可交付，最后给出完整的最终结果。',
    ],
    protocolMessage:
      '【工作协议】从现在起，每一轮回复结束时，请在最后单独输出一个进度摘要块，格式如下：\n【进度摘要】\n已完成：…\n未完成/阻塞：…\n下一步建议：…\n若任务已全部完成，请直接输出【任务完成】并给出最终交付内容。',
    injectProtocol: true,
    summaryMarker: '【进度摘要】',
    doneMarker: '【任务完成】',
  };
}
