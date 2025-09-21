/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
    return knex.schema.createTable("warehouses", (table) => {
        table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
        table.string("geo_name").notNullable().comment("Страна, для РФ — округ");
        table.string("warehouse_name").notNullable().comment("Название склада");
        table.timestamps(true, true);
        
        // Индексы для быстрого поиска
        table.index("geo_name");
        table.index("warehouse_name");
        
        // Уникальный индекс для предотвращения дубликатов складов
        table.unique(["geo_name", "warehouse_name"]);
    });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
    return knex.schema.dropTable("warehouses");
}
