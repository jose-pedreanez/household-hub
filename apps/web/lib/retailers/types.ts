/**
 * Retailer adapter contract. Capabilities differ by retailer; nothing here assumes a retailer API
 * exists. Availability is three-valued, and an API failure is "unknown", never "out of stock".
 */

export interface StoreProduct {
  retailerId: string;
  productId: string;
  name: string;
  packageSize: { amount: number; unit: string } | null;
  price: number | null;
  upc: string | null;
  source: "config" | "retailer_api";
}

export type AvailabilityStatus = "in_stock" | "out_of_stock" | "unknown";

export interface AvailabilityResult {
  status: AvailabilityStatus;
  /** Why the status is what it is (e.g. "no public inventory API", "API error: …"). */
  reason: string;
  checkedAt: string;
}

export interface ShoppingItem {
  name: string;
  quantity: number;
  unit: string | null;
  /** Human-readable amount, e.g. "2 × 1 lb". */
  display: string;
  note: string | null;
  upc: string | null;
}

export type ShoppingListResult =
  | { kind: "manual"; title: string; text: string; markdown: string; links: Array<{ name: string; url: string }> }
  | { kind: "link"; title: string; url: string; expiresInDays: number | null };

export interface CartResult {
  kind: "not_supported";
  reason: string;
}

export interface RetailerAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: { search: boolean; availability: boolean; listHandoff: "manual" | "link"; cart: false };
  searchProducts(query: string): Promise<StoreProduct[]>;
  getProduct(productId: string): Promise<StoreProduct | null>;
  getAvailability(productId: string): Promise<AvailabilityResult>;
  createShoppingList(items: ShoppingItem[], title: string): Promise<ShoppingListResult>;
  addToCart?(items: ShoppingItem[]): Promise<CartResult>;
}
