export const executionMode = process.env.POKI_MCP_EXECUTION_MODE ?? 'legacy';
if (!['legacy', 'optimized'].includes(executionMode)) throw new Error('POKI_MCP_EXECUTION_MODE must be legacy or optimized');
export const optimized = executionMode === 'optimized';
