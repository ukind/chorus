import { CreditCard, TrendingUp, Receipt } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";

const PACKS = [
  { credits: 1000, price: 10, popular: false, blurb: "≈ 200 reviews" },
  { credits: 5000, price: 45, popular: true, blurb: "≈ 1,000 reviews · save 10%" },
  { credits: 20000, price: 160, popular: false, blurb: "≈ 4,000 reviews · save 20%" },
];

const TX = [
  { date: "29 Apr", desc: "Migration plan · Aurora", model: "kimi-k2.6", debit: -42 },
  { date: "29 Apr", desc: "Decision help · Redis vs LRU", model: "deepseek-v4-pro", debit: -28 },
  { date: "28 Apr", desc: "Code review · pagination refactor", model: "qwen3-max", debit: -35 },
  { date: "28 Apr", desc: "Top-up", model: "—", debit: 5000 },
];

export default function CreditsPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Credits
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Pay-per-use access to models you don&apos;t have a sub for.
          </h1>
        </div>

        <Card className="mb-10 bg-card p-6">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <CreditCard className="h-3.5 w-3.5" />
                Balance
              </div>
              <div className="mt-2 text-3xl font-semibold sm:text-4xl tabular-nums">
                $12.40
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                ≈ 47 reviews remaining at average pack size
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              <span>spent $87 this month</span>
            </div>
          </div>
        </Card>

        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Top up
        </h2>
        <div className="mb-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PACKS.map((p) => (
            <Card
              key={p.credits}
              className={`relative bg-card p-5 transition ${p.popular ? "ring-1 ring-primary" : ""}`}
            >
              {p.popular && (
                <span className="absolute -top-2 left-5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary-foreground">
                  Most popular
                </span>
              )}
              <div className="text-2xl font-semibold tabular-nums">
                ${p.price}
              </div>
              <div className="mt-1 font-mono text-sm text-muted-foreground">
                {p.credits.toLocaleString()} credits
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {p.blurb}
              </div>
              <button
                type="button"
                className={`mt-4 w-full rounded-md py-2 text-sm font-medium transition ${
                  p.popular
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                Buy
              </button>
            </Card>
          ))}
        </div>

        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" />
          Recent activity
        </h2>
        <Card className="overflow-hidden bg-card p-0">
          <div className="grid grid-cols-12 gap-3 border-b border-border bg-card/60 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <div className="col-span-2">Date</div>
            <div className="col-span-6">Description</div>
            <div className="col-span-2">Model</div>
            <div className="col-span-2 text-right">Credits</div>
          </div>
          <ul>
            {TX.map((t, i) => (
              <li
                key={i}
                className="grid grid-cols-12 gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="col-span-2 font-mono text-xs text-muted-foreground">
                  {t.date}
                </div>
                <div className="col-span-6 text-sm">{t.desc}</div>
                <div className="col-span-2 font-mono text-[11px] text-muted-foreground">
                  {t.model}
                </div>
                <div
                  className={`col-span-2 text-right font-mono text-sm tabular-nums ${
                    t.debit > 0
                      ? "text-emerald-400"
                      : "text-foreground"
                  }`}
                >
                  {t.debit > 0 ? "+" : ""}
                  {t.debit}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}
