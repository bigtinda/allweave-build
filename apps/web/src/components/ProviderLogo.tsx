import { Building2 } from "lucide-react";
import { useState } from "react";

const providerLogoFiles: Record<string, string> = {
	"amazon-bedrock": "bedrock-color.svg",
	"ant-ling": "ant-ling.ico",
	anthropic: "anthropic.svg",
	azure: "azure-color.svg",
	baseten: "baseten.svg",
	cerebras: "cerebras-color.svg",
	"cloudflare-ai-gateway": "cloudflare-color.svg",
	"cloudflare-workers-ai": "cloudflare-color.svg",
	deepseek: "deepseek-color.svg",
	fireworks: "fireworks-color.svg",
	"github-copilot": "githubcopilot.svg",
	google: "google-color.svg",
	"google-vertex": "googlecloud-color.svg",
	groq: "groq.svg",
	huggingface: "huggingface-color.svg",
	"kimi-coding": "kimi.svg",
	meta: "meta-color.svg",
	minimax: "minimax-color.svg",
	"minimax-cn": "minimax-color.svg",
	mistral: "mistral-color.svg",
	moonshotai: "moonshot.svg",
	"moonshotai-cn": "moonshot.svg",
	nvidia: "nvidia-color.svg",
	openai: "openai.svg",
	"openai-codex": "codex-color.svg",
	opencode: "opencode.svg",
	"opencode-go": "opencode.svg",
	openrouter: "openrouter-color.svg",
	"qwen-token-plan": "qwen-color.svg",
	"qwen-token-plan-cn": "qwen-color.svg",
	"qwen-token-plan-individual": "qwen-color.svg",
	radius: "radius.ico",
	together: "together-color.svg",
	typesafe: "typesafe.png",
	"vercel-ai-gateway": "vercel.svg",
	xai: "xai.svg",
	xiaomi: "xiaomimimo.svg",
	"xiaomi-token-plan-ams": "xiaomimimo.svg",
	"xiaomi-token-plan-cn": "xiaomimimo.svg",
	"xiaomi-token-plan-sgp": "xiaomimimo.svg",
	zai: "zai.svg",
	"zai-coding-cn": "zai.svg",
};

export function ProviderLogo({ providerId }: { providerId: string }) {
	const logoFile = providerLogoFiles[providerId];
	const [failedProviderId, setFailedProviderId] = useState<string>();
	const failed = failedProviderId === providerId;

	return (
		<span className="provider-logo-tile" aria-hidden="true">
			{logoFile && !failed ? (
				<img src={`/provider-logos/${logoFile}`} alt="" onError={() => setFailedProviderId(providerId)} />
			) : (
				<Building2 size={17} />
			)}
		</span>
	);
}
