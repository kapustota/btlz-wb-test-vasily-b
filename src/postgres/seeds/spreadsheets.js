import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * @param {import("knex").Knex} knex
 * @returns {Promise<void>}
 */
export async function seed(knex) {
    // Читаем ID таблиц из JSON файла
    const configPath = process.env.GOOGLE_SPREADSHEETS_CONFIG_PATH;
    const spreadsheetPath = join(__dirname, "../../../", configPath);
    const spreadsheetIds = JSON.parse(readFileSync(spreadsheetPath, "utf-8"));

    // Преобразуем в объекты для вставки
    const spreadsheetData = spreadsheetIds.map((id) => ({
        spreadsheet_id: id
    }));

    // Вставляем данные (игнорируем дубликаты)
    await knex("spreadsheets")
        .insert(spreadsheetData)
        .onConflict(["spreadsheet_id"])
        .ignore();
        
    console.log(`Loaded ${spreadsheetData.length} spreadsheet IDs from JSON`);
}
