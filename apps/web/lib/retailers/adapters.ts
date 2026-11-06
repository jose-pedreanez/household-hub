import { z } from "zod";
import type { RetailerConfig } from "../config";
import { requestJson, type FetchLike } from "../http";
import type { AvailabilityResult, RetailerAdapter, ShoppingItem, ShoppingListResult, StoreProduct } from "./types";

type RetailerDef = RetailerConfig["retailers"][number];

/** Products a household configured for this retailer (the only catalogue we have without an API). */
function configuredProducts(cfg: RetailerConfig, retailerId: string): StoreProduct[] {
  const out: StoreProduct[] = [];
  for (const rule of cfg.products) {
    for (const src of [rule.preferred, ...rule.backups]) {
      if (!src || src.retailer !== retailerId) continue;
      out.push({
        retailerId,
        productId: `${rule.food}::${src.product}`.toLowerCase(),
        name: src.product,
        packageSize: src.packageSize ?? null,
        price: src.price ?? null,
        upc: src.upc ?? null,
        source: "config",
      });
    }
  }
  return out;
}

export function formatList(title: string, items: ShoppingItem[]): { text: string; markdown: string } {
  const lines = items.map((i) => `${i.display ? `${i.display} ` : ""}${i.name}${i.note ? ` (${i.note})` : ""}`);
  return {
    text: [title, "", ...lines.map((l) => `[ ] ${l}`)].join("\n"),
    markdown: [`## ${title}`, "", ...lines.map((l) => `- [ ] ${l}`)].join("\n"),
  };
}

/** Retailers without a usable public API: the hub prepares a list; a person shops and checks out. */
export class ManualRetailerAdapter implements RetailerAdapter {
  readonly capabilities = { search: true, availability: false, listHandoff: "manual" as const, cart: false as const };

  constructor(
    private readonly def: RetailerDef,
    private readonly cfg: RetailerConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get id() {
    return this.def.id;
  }
  get name() {
    return this.def.name;
  }

  async searchProducts(query: string): Promise<StoreProduct[]> {
    const q = query.trim().toLowerCase();
    return configuredProducts(this.cfg, this.def.id).filter((p) => p.name.toLowerCase().includes(q) || p.productId.includes(q));
  }

  async getProduct(productId: string): Promise<StoreProduct | null> {
    return configuredProducts(this.cfg, this.def.id).find((p) => p.productId === productId) ?? null;
  }

  async getAvailability(): Promise<AvailabilityResult> {
    return { status: "unknown", reason: `${this.def.name} has no public inventory API`, checkedAt: this.clock().toISOString() };
  }

  async createShoppingList(items: ShoppingItem[], title: string): Promise<ShoppingListResult> {
    const { text, markdown } = formatList(title, items);
    const links = this.def.searchUrlTemplate
      ? items.map((i) => ({ name: i.name, url: this.def.searchUrlTemplate!.replace("{query}", encodeURIComponent(i.name)) }))
      : [];
    return { kind: "manual", title, text, markdown, links };
  }
}

const instacartResponse = z.object({ products_link_url: z.string().url() }).loose();

/**
 * Instacart Developer Platform "Create shopping list page"
 * (POST /idp/v1/products/products_link, documented at docs.instacart.com/developer_platform_api).
 * The shopper chooses the store on Instacart's page; the hub cannot see availability there.
 */
export class InstacartListAdapter implements RetailerAdapter {
  readonly capabilities = { search: false, availability: false, listHandoff: "link" as const, cart: false as const };

  constructor(
    private readonly def: RetailerDef,
    private readonly apiKey: string,
    private readonly environment: "development" | "production",
    private readonly linkbackUrl: string | null,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get id() {
    return this.def.id;
  }
  get name() {
    return this.def.name;
  }

  private get baseUrl() {
    return this.environment === "production" ? "https://connect.instacart.com" : "https://connect.dev.instacart.tools";
  }

  async searchProducts(): Promise<StoreProduct[]> {
    return [];
  }
  async getProduct(): Promise<StoreProduct | null> {
    return null;
  }
  async getAvailability(): Promise<AvailabilityResult> {
    return { status: "unknown", reason: "Instacart shows availability only after the shopper picks a store", checkedAt: this.clock().toISOString() };
  }

  async createShoppingList(items: ShoppingItem[], title: string): Promise<ShoppingListResult> {
    const body = {
      title,
      link_type: "shopping_list",
      expires_in: 7,
      line_items: items.map((i) => {
        // Unsupported unit strings break Instacart's quantity matching, so only "each" (a package
        // count) is sent; the measured amount travels in display_text for the shopper.
        const line: Record<string, unknown> = {
          name: i.name,
          display_text: i.display ? `${i.display} ${i.name}` : i.name,
          line_item_measurements: [{ quantity: Math.max(1, Math.ceil(i.unit ? 1 : i.quantity)), unit: "each" }],
        };
        if (i.upc && /^\d{12}$|^\d{14}$/.test(i.upc)) line.upcs = [i.upc];
        return line;
      }),
      ...(this.linkbackUrl ? { landing_page_configuration: { partner_linkback_url: this.linkbackUrl } } : {}),
    };
    const raw = await requestJson("Instacart", `${this.baseUrl}/idp/v1/products/products_link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body,
      timeoutMs: 15_000,
    }, this.fetchImpl);
    const parsed = instacartResponse.parse(raw);
    return { kind: "link", title, url: parsed.products_link_url, expiresInDays: 7 };
  }
}

export function buildAdapters(
  cfg: RetailerConfig,
  opts: { instacartApiKey?: string; instacartEnv: "development" | "production"; publicBaseUrl: string | null },
): Map<string, RetailerAdapter> {
  const out = new Map<string, RetailerAdapter>();
  for (const def of cfg.retailers) {
    if (def.adapter === "instacart" && opts.instacartApiKey) {
      out.set(def.id, new InstacartListAdapter(def, opts.instacartApiKey, opts.instacartEnv, opts.publicBaseUrl ? `${opts.publicBaseUrl}/shopping` : null));
    } else {
      out.set(def.id, new ManualRetailerAdapter(def, cfg));
    }
  }
  return out;
}
