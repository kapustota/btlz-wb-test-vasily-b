/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
    return knex.schema.createTable("box_rates", (table) => {
        table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
        
        // Внешние ключи
        table.uuid("warehouse_id").notNullable();
        table.uuid("tariff_period_id").notNullable();
        
        // Логистика (3 поля)
        table.decimal("box_delivery_base", 10, 2).notNullable().comment("Логистика, первый литр, ₽");
        table.decimal("box_delivery_coef", 10, 2).notNullable().comment("Коэффициент Логистика");
        table.decimal("box_delivery_liter", 10, 2).notNullable().comment("Логистика, дополнительный литр, ₽");
        
        // Логистика FBS (3 поля)
        table.decimal("box_delivery_marketplace_base", 10, 2).notNullable().comment("Логистика FBS, первый литр, ₽");
        table.decimal("box_delivery_marketplace_coef", 10, 2).notNullable().comment("Коэффициент FBS");
        table.decimal("box_delivery_marketplace_liter", 10, 2).notNullable().comment("Логистика FBS, дополнительный литр, ₽");
        
        // Хранение (3 поля)
        table.decimal("box_storage_base", 10, 2).notNullable().comment("Хранение в день, первый литр, ₽");
        table.decimal("box_storage_coef", 10, 2).notNullable().comment("Коэффициент Хранение");
        table.decimal("box_storage_liter", 10, 2).notNullable().comment("Хранение в день, дополнительный литр, ₽");
        
        table.timestamps(true, true);
        
        // Внешние ключи
        table.foreign("warehouse_id").references("id").inTable("warehouses").onDelete("CASCADE");
        table.foreign("tariff_period_id").references("id").inTable("tariff_periods").onDelete("CASCADE");
        
        // Индексы
        table.index("warehouse_id");
        table.index("tariff_period_id");
        
        // Уникальный индекс - один тариф на склад в период
        table.unique(["warehouse_id", "tariff_period_id"]);
    });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
    return knex.schema.dropTable("box_rates");
}
