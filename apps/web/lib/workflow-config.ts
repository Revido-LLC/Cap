export function canUseWorkflowEngine(): boolean {
	return !!process.env.VERCEL_DEPLOYMENT_ID;
}
