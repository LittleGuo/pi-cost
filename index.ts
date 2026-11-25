/**
 * pi-cost: shows the DeepSeek account balance and this session's cost in the footer.
 *
 * Balance comes from DeepSeek's GET /user/balance (CNY account), session cost is the sum of pi's
 * usage cost for the current branch, already in CNY. Costs are listed at peak rates; off-peak
 * calls (nights, weekends, CN public holidays) are billed at half, so they are halved here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-cost";
// models.json costs are filled in CNY per million tokens (pi labels them USD, so its own footer shows $).
const BALANCE_TTL_MS = 5 * 60_000;

// DeepSeek bills peak hours 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excluding Chinese public
// holidays (i.e. 09:00-12:00 and 14:00-18:00 Beijing time). Off-peak rates are half of peak rates.
const PEAK_UTC_HOURS: [number, number][] = [
	[1, 4],
	[6, 10],
];
const OFF_PEAK_FACTOR = 0.5;
// CN public holidays (国务院办公厅 2026/2027 安排, via NateScarlet/holiday-cn). Update when a new
// year is published; 调休补班的周末仍是周末，本来就落在谷时。
// shortcut: years past 2027 are not covered, add them here or via PI_CN_HOLIDAYS.
const CN_HOLIDAYS = new Set(
	[
		"2026-01-01 2026-01-02 2026-01-03",
		"2026-02-15 2026-02-16 2026-02-17 2026-02-18 2026-02-19 2026-02-20 2026-02-21 2026-02-22 2026-02-23",
		"2026-04-04 2026-04-05 2026-04-06",
		"2026-05-01 2026-05-02 2026-05-03 2026-05-04 2026-05-05",
		"2026-06-19 2026-06-20 2026-06-21",
		"2026-09-25 2026-09-26 2026-09-27",
		"2026-10-01 2026-10-02 2026-10-03 2026-10-04 2026-10-05 2026-10-06 2026-10-07",
		"2027-01-01 2027-01-02 2027-01-03",
		"2027-02-05 2027-02-06 2027-02-07 2027-02-08 2027-02-09 2027-02-10 2027-02-11 2027-02-12 2027-02-13",
		"2027-04-03 2027-04-04 2027-04-05",
		"2027-05-01 2027-05-02 2027-05-03 2027-05-04 2027-05-05",
		"2027-06-09",
		"2027-09-15",
		"2027-10-01 2027-10-02 2027-10-03 2027-10-04 2027-10-05 2027-10-06 2027-10-07",
		process.env.PI_CN_HOLIDAYS ?? "",
	]
		.join(" ")
		.split(/[\s,]+/)
		.filter(Boolean),
);

function isOffPeak(at: Date): boolean {
	const day = at.getUTCDay();
	if (day === 0 || day === 6) return true;
	if (CN_HOLIDAYS.has(at.toISOString().slice(0, 10))) return true;
	const hour = at.getUTCHours();
	return !PEAK_UTC_HOURS.some(([start, end]) => hour >= start && hour < end);
}

/** pi always bills at the configured (peak) rates; DeepSeek charges half of that in off-peak hours. */
function toActualCost(cost: number, at: Date | undefined, provider: string | undefined): number {
	if (provider !== "deepseek" || !at) return cost;
	return isOffPeak(at) ? cost * OFF_PEAK_FACTOR : cost;
}

let balanceText: string | undefined;
let balanceProvider: string | undefined;
let balanceCheckedAt = 0;

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

function formatMoney(amount: number, currency: string): string {
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
	const digits = amount === 0 ? 2 : amount < 1 ? 4 : 2;
	return `${symbol}${amount.toFixed(digits)}`;
}

function sessionUsage(ctx: ExtensionContext): { cost: number; tokens: number } {
	let cost = 0;
	let tokens = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type: string;
			timestamp?: string;
			provider?: string;
			model?: string;
			usage?: Usage;
			message?: { provider?: string; timestamp?: number; usage?: Usage };
		};
		const usage = e.type === "message" ? e.message?.usage : e.usage;
		if (!usage) continue;
		const ms = e.type === "message" ? e.message?.timestamp : e.timestamp ? Date.parse(e.timestamp) : undefined;
		const at = typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : undefined;
		const provider = e.type === "message" ? e.message?.provider : e.provider;
		if (typeof usage.cost?.total === "number") {
			cost += toActualCost(usage.cost.total, at, provider);
		}
		tokens +=
			usage.totalTokens ??
			(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	}
	return { cost, tokens };
}

function paintStatus(ctx: ExtensionContext): void {
	const { cost, tokens } = sessionUsage(ctx);
	const parts: string[] = [];
	if (balanceText) parts.push(`余额 ${balanceText}`);
	// pi substitutes zero rates when models.json has no cost, so non-zero usage with zero cost means unpriced.
	parts.push(`本会话 ${tokens > 0 && cost === 0 ? "未配置单价" : formatMoney(cost, "CNY")}`);
	ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
}

async function refreshBalance(ctx: ExtensionContext): Promise<void> {
	const model = ctx.model;
	if (!model) return;
	if (model.provider !== balanceProvider) {
		balanceProvider = model.provider;
		balanceText = undefined;
	}
	balanceCheckedAt = Date.now();
	if (model.provider !== "deepseek") return; // only DeepSeek exposes /user/balance

	try {
		const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
		const apiKey = auth?.auth.apiKey;
		if (!apiKey) return;
		const baseUrl = (auth?.auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
		const response = await fetch(`${baseUrl}/user/balance`, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return;
		const data = (await response.json()) as {
			balance_infos?: { currency?: string; total_balance?: string }[];
		};
		const info = data.balance_infos?.find((i) => i.currency === "CNY") ?? data.balance_infos?.[0];
		const amount = Number(info?.total_balance);
		if (info?.currency && Number.isFinite(amount)) balanceText = formatMoney(amount, info.currency);
	} catch {
		// Best effort: keep the last known balance and try again after the TTL.
	}
}

export default function (pi: ExtensionAPI) {
	const refresh = async (_event: unknown, ctx: ExtensionContext) => {
		await refreshBalance(ctx);
		paintStatus(ctx);
	};

	pi.on("session_start", refresh);
	pi.on("model_select", refresh);
	pi.on("turn_end", async (_event, ctx) => {
		if (Date.now() - balanceCheckedAt > BALANCE_TTL_MS) await refreshBalance(ctx);
		paintStatus(ctx);
	});
}
