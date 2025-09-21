/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function up(knex) {
    return knex.schema.createTable("tariff_periods", (table) => {
        table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
        table.date("start_date").notNullable().comment("Дата начала действия тарифа");
        table.date("end_date").nullable().comment("Дата окончания действия тарифа");
        table.timestamps(true, true);
        
        // Индексы для быстрого поиска по датам
        table.index("start_date");
        table.index("end_date");
        
        // Составной индекс для поиска активных тарифов
        table.index(["start_date", "end_date"]);
    });
}

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function down(knex) {
    return knex.schema.dropTable("tariff_periods");
}
