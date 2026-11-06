import { z } from "zod";

/** Grocy serialises many numbers and flags as strings; normalise at the boundary. */
const num = z.preprocess((v) => (v === "" || v === undefined ? null : v === null ? null : Number(v)), z.number().nullable());
const reqNum = z.preprocess((v) => Number(v), z.number());
const int = z.preprocess((v) => (v === "" || v === undefined || v === null ? null : Number(v)), z.number().int().nullable());
const reqInt = z.preprocess((v) => Number(v), z.number().int());
const flag = z.preprocess((v) => v === 1 || v === "1" || v === true, z.boolean());
const str = z.string().nullable().optional().transform((v) => (v === undefined || v === "" ? null : v));

export const grocyProductSchema = z
  .object({
    id: reqInt,
    name: z.string(),
    description: str,
    location_id: int,
    shopping_location_id: int.optional(),
    product_group_id: int.optional(),
    qu_id_stock: reqInt,
    qu_id_purchase: reqInt,
    qu_id_consume: int.optional(),
    qu_id_price: int.optional(),
    min_stock_amount: num.optional(),
    default_best_before_days: int.optional(),
    default_best_before_days_after_open: int.optional(),
    parent_product_id: int.optional(),
    no_own_stock: flag.optional(),
    calories: num.optional(),
    active: flag.optional(),
    enable_tare_weight_handling: flag.optional(),
    should_not_be_frozen: flag.optional(),
    treat_opened_as_out_of_stock: flag.optional(),
  })
  .loose();
export type GrocyProduct = z.infer<typeof grocyProductSchema>;

export const quantityUnitSchema = z
  .object({ id: reqInt, name: z.string(), name_plural: str, description: str })
  .loose();
export type QuantityUnit = z.infer<typeof quantityUnitSchema>;

export const locationSchema = z
  .object({ id: reqInt, name: z.string(), description: str, is_freezer: flag.optional() })
  .loose();
export type GrocyLocation = z.infer<typeof locationSchema>;

export const shoppingLocationSchema = z.object({ id: reqInt, name: z.string(), description: str }).loose();
export type ShoppingLocation = z.infer<typeof shoppingLocationSchema>;

export const productGroupSchema = z.object({ id: reqInt, name: z.string(), description: str }).loose();
export type ProductGroup = z.infer<typeof productGroupSchema>;

export const productBarcodeSchema = z
  .object({
    id: reqInt,
    product_id: reqInt,
    barcode: z.string(),
    qu_id: int.optional(),
    amount: num.optional(),
    shopping_location_id: int.optional(),
    last_price: num.optional(),
    note: str,
  })
  .loose();
export type ProductBarcode = z.infer<typeof productBarcodeSchema>;

/** Row of the `quantity_unit_conversions_resolved` view: every usable conversion, incl. derived ones. */
export const resolvedConversionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    product_id: int,
    from_qu_id: reqInt,
    to_qu_id: reqInt,
    factor: reqNum,
  })
  .loose();
export type ResolvedConversion = z.infer<typeof resolvedConversionSchema>;

export const quantityUnitConversionSchema = z
  .object({ id: reqInt, product_id: int, from_qu_id: reqInt, to_qu_id: reqInt, factor: reqNum })
  .loose();
export type QuantityUnitConversion = z.infer<typeof quantityUnitConversionSchema>;

export const productDetailsSchema = z
  .object({
    product: grocyProductSchema,
    product_barcodes: z.array(productBarcodeSchema).optional().default([]),
    quantity_unit_stock: quantityUnitSchema,
    default_quantity_unit_purchase: quantityUnitSchema.nullable().optional(),
    stock_amount: num,
    stock_amount_opened: num,
    stock_amount_aggregated: num.optional(),
    next_due_date: str,
    last_price: num.optional(),
    last_shopping_location_id: int.optional(),
    location: locationSchema.nullable().optional(),
    default_location: locationSchema.nullable().optional(),
    has_childs: z.preprocess((v) => v === true || v === 1 || v === "1", z.boolean()).optional(),
  })
  .loose();
export type ProductDetails = z.infer<typeof productDetailsSchema>;

export const stockEntrySchema = z
  .object({
    id: reqInt,
    product_id: reqInt,
    location_id: int,
    shopping_location_id: int.optional(),
    amount: reqNum,
    best_before_date: str,
    purchased_date: str,
    stock_id: z.string(),
    price: num.optional(),
    open: flag,
    opened_date: str,
    note: str,
  })
  .loose();
export type StockEntry = z.infer<typeof stockEntrySchema>;

export const stockLogEntrySchema = z
  .object({
    id: reqInt,
    product_id: reqInt,
    amount: reqNum,
    best_before_date: str,
    purchased_date: str,
    used_date: str,
    spoiled: flag.optional(),
    stock_id: str,
    transaction_id: z.string(),
    transaction_type: z.string(),
    note: str,
    undone: flag.optional(),
    location_id: int.optional(),
    row_created_timestamp: str,
  })
  .loose();
export type StockLogEntry = z.infer<typeof stockLogEntrySchema>;

export const currentStockSchema = z
  .object({
    product_id: reqInt,
    amount: reqNum,
    amount_aggregated: num.optional(),
    amount_opened: num.optional(),
    best_before_date: str,
    is_aggregated_amount: flag.optional(),
    product: grocyProductSchema,
  })
  .loose();
export type CurrentStock = z.infer<typeof currentStockSchema>;

const volatileItem = z
  .object({
    product_id: reqInt,
    amount: num.optional(),
    amount_missing: num.optional(),
    best_before_date: str,
    name: z.string().optional(),
    product: grocyProductSchema.optional(),
  })
  .loose();

export const volatileStockSchema = z
  .object({
    due_products: z.array(volatileItem).default([]),
    overdue_products: z.array(volatileItem).default([]),
    expired_products: z.array(volatileItem).default([]),
    missing_products: z.array(volatileItem).default([]),
  })
  .loose();
export type VolatileStock = z.infer<typeof volatileStockSchema>;

export const createdObjectSchema = z.object({ created_object_id: reqInt }).loose();

export const systemInfoSchema = z
  .object({ grocy_version: z.object({ Version: z.string(), ReleaseDate: z.string().optional() }).loose() })
  .loose();
