import { Logger } from "./utils/Logger.js";
import { WildberriesApiService } from "./services/WildberriesApiService.js";
import { GoogleSheetsService } from "./services/GoogleSheetsService.js";
import { DataProcessor } from "./services/DataProcessor.js";
import knex from "#postgres/knex.js";
import env from "#config/env/env.js";

/**
 * Синхронизация тарифов с Wildberries API
 */
export async function syncRates() {
    const logger = new Logger("SyncRates");
    
    try {
        logger.info("Starting rates synchronization...");
        
        // 1. Получение данных от WB API
        logger.info("Step 1: Fetching data from Wildberries API");
        const wbService = new WildberriesApiService(env.WB_TOKEN);
        const wbData = await wbService.getWarehouseBoxRates();
        logger.info(`Received ${wbData?.warehouseList?.length || 'undefined'} warehouse rates from WB API`);
        
        if (!wbData || !wbData.warehouseList) {
            logger.warn("No data received from WB API - exiting");
            return;
        }
        
        // 2. Обработка и сохранение данных
        logger.info("Step 2: Processing and saving data");
        const processor = new DataProcessor();
        const result = await processor.transformAndSaveDataToDb(wbData);
        logger.info(`Processed and saved: ${result.tariffPeriodsCount} tariff periods, ${result.warehousesCount} warehouses, ${result.boxRatesCount} box rates`);
        
        // 3. Получение актуальных данных для Google Sheets
        logger.info("Step 3: Fetching current rates for Google Sheets");
        const currentRates = await getDataForGoogleSheets();
        logger.info(`Found ${currentRates.length} current rates for Google Sheets`);
        
        // 4. Обновление Google Sheets
        logger.info("Step 4: Updating Google Sheets");
        const sheetsService = new GoogleSheetsService(env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
        await sheetsService.updateSpreadsheets(currentRates, "stocks_coefs");
        
        logger.info("Rates synchronization completed successfully!");
        
    } catch (error) {
        logger.error("Error during rates synchronization:", error);
        throw error;
    }
}

/**
 * Получение актуальных данных для Google Sheets
 */
async function getDataForGoogleSheets() {
    const logger = new Logger("GetDataForGoogleSheets");
    
    try {
        // Получаем актуальные тарифы (с end_date = null или end_date >= today)
        const today = new Date();
        
        const currentRates = await knex('box_rates')
            .join('warehouses', 'box_rates.warehouse_id', 'warehouses.id')
            .join('tariff_periods', 'box_rates.tariff_period_id', 'tariff_periods.id')
            .where(function() {
                this.whereNull('tariff_periods.end_date')
                    .orWhere('tariff_periods.end_date', '>=', today);
            })
            .select(
                'warehouses.geo_name',
                'warehouses.warehouse_name',
                'box_rates.box_delivery_base',
                'box_rates.box_delivery_coef',
                'box_rates.box_delivery_liter',
                'box_rates.box_delivery_marketplace_base',
                'box_rates.box_delivery_marketplace_coef',
                'box_rates.box_delivery_marketplace_liter',
                'box_rates.box_storage_base',
                'box_rates.box_storage_coef',
                'box_rates.box_storage_liter',
                'tariff_periods.start_date',
                'tariff_periods.end_date'
            )
            .orderBy('box_rates.box_storage_coef', 'asc')
            .orderBy('warehouses.geo_name');
        
        logger.info(`Retrieved ${currentRates.length} current rates from database`);
        return currentRates;
        
    } catch (error) {
        logger.error("Error fetching data for Google Sheets:", error);
        throw error;
    }
}

// Запуск синхронизации если файл выполняется напрямую
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     import.meta.url.endsWith(process.argv[1]) ||
                     process.argv[1]?.endsWith('syncRates.ts');

if (isMainModule) {
    console.log("Running syncRates...");
    syncRates()
        .then(() => {
            console.log("Sync completed successfully");
            process.exit(0);
        })
        .catch((error) => {
            console.error("Sync failed:", error);
            process.exit(1);
        });
}