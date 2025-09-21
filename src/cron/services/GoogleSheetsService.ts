import { google } from "googleapis";
import knex from "#postgres/knex.js";
import { Logger } from "../utils/Logger.js";

/**
 * Сервис для работы с Google Sheets
 */
export class GoogleSheetsService {
    private readonly serviceAccountKeyPath: string;
    private readonly logger: Logger;
    private sheets: any;

    constructor(serviceAccountKeyPath: string) {
        this.serviceAccountKeyPath = serviceAccountKeyPath;
        this.logger = new Logger("GoogleSheetsService");
    }

    /**
     * Инициализация Google Sheets API
     */
    private async initializeGoogleSheets() {
        if (this.sheets) {
            return this.sheets;
        }

        try {
            this.logger.info("Initializing Google Sheets API");

            // Авторизация через service account
            const auth = new google.auth.GoogleAuth({
                keyFile: this.serviceAccountKeyPath,
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });

            this.sheets = google.sheets({ version: 'v4', auth });

            this.logger.info("Google Sheets API initialized");
            return this.sheets;

        } catch (error) {
            this.logger.error("Error initializing Google Sheets API:", error);
            throw new Error(`Failed to initialize Google Sheets API: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Обновление всех таблиц данными из БД
     */
    async updateSpreadsheets(data: GoogleSheetsData[], pageName: string) {
        this.logger.info(`Starting update of Google Sheets with ${data.length} records`);

        try {
            const sheets = await this.initializeGoogleSheets();
            
            // Получаем список ID таблиц из БД
            const spreadsheetIds = await this.getSpreadsheetIds();
            this.logger.info(`Found ${spreadsheetIds.length} spreadsheets to update`);

            // Обновляем каждую таблицу
            for (const spreadsheetId of spreadsheetIds) {
                await this.updateSingleSpreadsheet(sheets, spreadsheetId, data, pageName);
            }

            this.logger.info("All spreadsheets updated successfully");

        } catch (error) {
            this.logger.error("Error updating spreadsheets:", error);
            throw new Error(`Failed to update spreadsheets: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Получение списка ID таблиц из БД
     */
    private async getSpreadsheetIds(): Promise<string[]> {
        const results = await knex('spreadsheets')
            .select('spreadsheet_id')
            .orderBy('spreadsheet_id');
        
        return results.map(row => row.spreadsheet_id);
    }

    /**
     * Обновление одной таблицы
     */
    private async updateSingleSpreadsheet(
        sheets: any, 
        spreadsheetId: string, 
        data: GoogleSheetsData[], 
        pageName: string
    ) {
        this.logger.info(`Updating spreadsheet ${spreadsheetId}`);

        try {
            // Проверяем существование листа и создаем его при необходимости
            await this.ensureSheetExists(sheets, spreadsheetId, pageName);
            
            const range = `${pageName}!A1:Z1000`; // Достаточно большой диапазон
            
            // Очищаем существующие данные
            await sheets.spreadsheets.values.clear({
                spreadsheetId,
                range
            });

            // Подготавливаем данные для вставки
            const values = this.prepareDataForSheets(data);

            // Вставляем новые данные
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${pageName}!A1`,
                valueInputOption: 'RAW',
                resource: {
                    values
                }
            });

            this.logger.info(`Successfully updated spreadsheet ${spreadsheetId} with ${values.length} rows`);

        } catch (error) {
            this.logger.error(`Error updating spreadsheet ${spreadsheetId}:`, error);
            throw error;
        }
    }

    /**
     * Проверка существования листа и создание его при необходимости
     */
    private async ensureSheetExists(sheets: any, spreadsheetId: string, sheetName: string) {
        try {
            // Получаем информацию о таблице
            const spreadsheet = await sheets.spreadsheets.get({
                spreadsheetId
            });

            // Проверяем, существует ли лист с нужным именем
            const existingSheet = spreadsheet.data.sheets?.find((sheet: any) => 
                sheet.properties.title === sheetName
            );

            if (!existingSheet) {
                this.logger.info(`Sheet '${sheetName}' not found, creating it...`);
                
                // Создаем новый лист
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: {
                        requests: [{
                            addSheet: {
                                properties: {
                                    title: sheetName
                                }
                            }
                        }]
                    }
                });
                
                this.logger.info(`Sheet '${sheetName}' created successfully`);
            } else {
                this.logger.info(`Sheet '${sheetName}' already exists`);
            }

        } catch (error) {
            this.logger.error(`Error ensuring sheet '${sheetName}' exists:`, error);
            throw error;
        }
    }

    /**
     * Подготовка данных для Google Sheets (преобразование в двумерный массив)
     * Показывает только актуальные тарифы без ID, отсортированные по FBS коэффициенту
     */
    private prepareDataForSheets(data: GoogleSheetsData[]): string[][] {
        if (data.length === 0) {
            return [["Нет актуальных тарифов"]];
        }

        const headers = [
            "Регион",
            "Склад",
            "Дата начала",
            "Дата окончания",
            "Логистика (₽/л)",
            "Логистика коэф",
            "Логистика доп (₽/л)",
            "FBS база (₽/л)",
            "FBS коэф",
            "FBS доп (₽/л)",
            "Хранение (₽/л/день)",
            "Хранение коэф",
            "Хранение доп (₽/л/день)"
        ];

        // Данные с форматированием
        const rows = data.map(row => [
            row.geo_name || "",
            row.warehouse_name || "",
            this.formatDate(row.start_date),
            this.formatEndDate(row.end_date),
            this.formatNumber(row.box_delivery_base),
            this.formatNumber(row.box_delivery_coef),
            this.formatNumber(row.box_delivery_liter),
            this.formatNumber(row.box_delivery_marketplace_base),
            this.formatNumber(row.box_delivery_marketplace_coef),
            this.formatNumber(row.box_delivery_marketplace_liter),
            this.formatNumber(row.box_storage_base),
            this.formatNumber(row.box_storage_coef),
            this.formatNumber(row.box_storage_liter),
        ]);

        return [headers, ...rows];
    }

    /**
     * Форматирование даты окончания (с датой и временем до минут)
     */
    private formatEndDate(endDate: string | null): string {
        if (!endDate) {
            return "-";  // Бессрочный тариф
        }
        
        return this.formatDate(endDate);
    }

    /**
     * Форматирование даты и времени в читаемый вид (до минут)
     */
    private formatDate(dateString: string): string {
        try {
            const date = new Date(dateString);
            return date.toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit', 
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } catch (error) {
            return dateString;  // Возвращаем как есть если не удалось распарсить
        }
    }

    /**
     * Форматирование числовых значений
     */
    private formatNumber(value: any): string {
        if (value === null || value === undefined || value === "" || isNaN(value)) return "-";
        const num = Number(value);
        return num.toFixed(2);
    }

}

/**
 * Типы данных для Google Sheets
 */
export interface GoogleSheetsData {
    geo_name: string;
    warehouse_name: string;
    start_date: string;
    end_date: string | null;
    box_delivery_base: number;
    box_delivery_coef: number;
    box_delivery_liter: number;
    box_delivery_marketplace_base: number;
    box_delivery_marketplace_coef: number;
    box_delivery_marketplace_liter: number;
    box_storage_base: number;
    box_storage_coef: number;
    box_storage_liter: number;
}
