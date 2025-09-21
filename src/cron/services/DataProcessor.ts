import { Logger } from "../utils/Logger.js";
import { WbWarehouseBoxRatesResponse, WbWarehouseBoxRate } from "./WildberriesApiService.js";
import knex from "#postgres/knex.js";

export class DataProcessor {
    private readonly logger: Logger;

    constructor() {
        this.logger = new Logger("DataProcessor");
    }

    async transformAndSaveDataToDb(wbData: WbWarehouseBoxRatesResponse): Promise<ProcessResult> {
        this.logger.info("Starting data transformation and saving to database");

        return await knex.transaction(async (trx) => {
            try {
                const processedData = this.convertWbDataToProcessedData(wbData);
                
                // Обрабатываем склады и заполняем их ID
                await this.processWarehouses(processedData, trx);
                
                // Обрабатываем тарифные периоды и тарифы для каждого склада индивидуально
                const result = await this.processTariffPeriodsAndRates(processedData, trx);

                this.logger.info(`Successfully processed: ${result.tariffPeriodsCount} tariff periods, ${processedData.warehouses.length} warehouses, ${result.boxRatesCount} box rates`);
                
                return result;

        } catch (error) {
                this.logger.error("Error during data processing:", error);
                throw new Error(`Data processing failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    private convertWbDataToProcessedData(wbData: WbWarehouseBoxRatesResponse): ProcessedData {
        return {
            warehouses: wbData.warehouseList.map(wbWarehouse => ({
                geo_name: wbWarehouse.geoName,
                warehouse_name: wbWarehouse.warehouseName,
            })),
            boxRates: wbData.warehouseList.map(wbRate => ({
                box_delivery_base: Number(wbRate.boxDeliveryBase.replace(',', '.')),
                box_delivery_coef: Number(wbRate.boxDeliveryCoefExpr.replace(',', '.')),
                box_delivery_liter: Number(wbRate.boxDeliveryLiter.replace(',', '.')),
                box_delivery_marketplace_base: Number(wbRate.boxDeliveryMarketplaceBase.replace(',', '.')),
                box_delivery_marketplace_coef: Number(wbRate.boxDeliveryMarketplaceCoefExpr.replace(',', '.')),
                box_delivery_marketplace_liter: Number(wbRate.boxDeliveryMarketplaceLiter.replace(',', '.')),
                box_storage_base: Number(wbRate.boxStorageBase.replace(',', '.')),
                box_storage_coef: Number(wbRate.boxStorageCoefExpr.replace(',', '.')),
                box_storage_liter: Number(wbRate.boxStorageLiter.replace(',', '.')),
            })),
            tariffPeriodEndDate: new Date(wbData.dtTillMax)
        };
    }

    private async processTariffPeriodsAndRates(processedData: ProcessedData, trx: any): Promise<ProcessResult> {
        this.logger.info(`Processing tariff periods and rates for ${processedData.warehouses.length} warehouses`);
        
        const now = new Date();
        
        let tariffPeriodsCount = 0;
        let boxRatesCount = 0;

        for (let i = 0; i < processedData.warehouses.length; i++) {
            const warehouse = processedData.warehouses[i];
            const boxRate = processedData.boxRates[i];

            if (!warehouse.id) {
                this.logger.warn(`Missing warehouse ID at index ${i}`);
                continue;
            }

            // Находим текущий активный период для этого склада
            const currentPeriod = await this.getCurrentPeriodForWarehouse(warehouse.id, now, trx);
            
            if (currentPeriod) {
                // Проверяем, изменились ли тарифы для этого склада
                const ratesMatch = await this.checkRatesMatchForWarehouse(currentPeriod.id, warehouse.id, boxRate, trx);
                
                if (ratesMatch) {
                    // Тарифы не изменились - продлеваем текущий период
                    await trx('tariff_periods')
                        .where('id', currentPeriod.id)
                        .update({ end_date: processedData.tariffPeriodEndDate });
                    
                    // Связываем тариф с существующим периодом
                    boxRate.tariff_period_id = currentPeriod.id;
                    boxRate.warehouse_id = warehouse.id;
                    
                    this.logger.info(`Extended period ${currentPeriod.id} for warehouse ${warehouse.geo_name} - ${warehouse.warehouse_name} until ${processedData.tariffPeriodEndDate.toISOString()} - no new rates needed`);
                } else {
                    // Тарифы изменились - закрываем старый период текущим временем и создаем новый
                    await trx('tariff_periods')
                        .where('id', currentPeriod.id)
                        .update({ end_date: now });
                    
                    const [newPeriod] = await trx('tariff_periods')
                        .insert({
                            start_date: now,
                            end_date: processedData.tariffPeriodEndDate
                        })
                        .returning('*');
                    
                    // Связываем тариф с новым периодом
                    boxRate.tariff_period_id = newPeriod.id;
                    boxRate.warehouse_id = warehouse.id;
                    
                    tariffPeriodsCount++;
                    boxRatesCount++;
                    
                    this.logger.info(`Closed period ${currentPeriod.id} at ${now.toISOString()} and created new period ${newPeriod.id} from ${now.toISOString()} for warehouse ${warehouse.geo_name} - ${warehouse.warehouse_name} - new rates needed`);
                }
            } else {
                // Нет текущего периода для этого склада - создаем новый
                const [newPeriod] = await trx('tariff_periods')
                    .insert({
                        start_date: now,
                        end_date: processedData.tariffPeriodEndDate
                    })
                    .returning('*');
                
                // Связываем тариф с новым периодом
                boxRate.tariff_period_id = newPeriod.id;
                boxRate.warehouse_id = warehouse.id;
                
                tariffPeriodsCount++;
                boxRatesCount++;
                
                this.logger.info(`Created new period ${newPeriod.id} from ${now.toISOString()} for warehouse ${warehouse.geo_name} - ${warehouse.warehouse_name} - new rates needed`);
            }
        }

        // Сохраняем все тарифы (как новые, так и обновленные)
        await this.saveBoxRates(processedData, trx);

        return {
            tariffPeriodsCount,
            warehousesCount: processedData.warehouses.length,
            boxRatesCount
        };
    }

    private async getCurrentPeriodForWarehouse(warehouseId: string, now: Date, trx: any): Promise<any> {
        // Находим текущий активный период для конкретного склада
        const currentRate = await trx('box_rates')
            .join('tariff_periods', 'box_rates.tariff_period_id', 'tariff_periods.id')
            .where('box_rates.warehouse_id', warehouseId)
            .where('tariff_periods.start_date', '<=', now)
            .where(function(this: any) {
                this.whereNull('tariff_periods.end_date').orWhere('tariff_periods.end_date', '>=', now);
            })
            .select('tariff_periods.*')
            .first();

        return currentRate;
    }

    private async checkRatesMatchForWarehouse(periodId: string, warehouseId: string, newRate: ProcessedBoxRate, trx: any): Promise<boolean> {
        this.logger.info(`Checking rates match for period ${periodId} and warehouse ${warehouseId}`);
    
        const existingRate = await trx('box_rates')
            .where('tariff_period_id', periodId)
            .where('warehouse_id', warehouseId)
            .select(
                knex.raw('box_delivery_base::float as box_delivery_base'),
                knex.raw('box_delivery_coef::float as box_delivery_coef'),
                knex.raw('box_delivery_liter::float as box_delivery_liter'),
                knex.raw('box_delivery_marketplace_base::float as box_delivery_marketplace_base'),
                knex.raw('box_delivery_marketplace_coef::float as box_delivery_marketplace_coef'),
                knex.raw('box_delivery_marketplace_liter::float as box_delivery_marketplace_liter'),
                knex.raw('box_storage_base::float as box_storage_base'),
                knex.raw('box_storage_coef::float as box_storage_coef'),
                knex.raw('box_storage_liter::float as box_storage_liter')
            )
            .first();

        if (!existingRate) {
            this.logger.info(`No existing rate found for period ${periodId} and warehouse ${warehouseId} - rates don't match`);
            return false;
        }

        // Сравниваем все числовые поля (с точностью до 2 знаков после запятой)
        const fieldsToCompare = [
            { processed: newRate.box_delivery_base, db: existingRate.box_delivery_base, name: 'box_delivery_base' },
            { processed: newRate.box_delivery_coef, db: existingRate.box_delivery_coef, name: 'box_delivery_coef' },
            { processed: newRate.box_delivery_liter, db: existingRate.box_delivery_liter, name: 'box_delivery_liter' },
            { processed: newRate.box_delivery_marketplace_base, db: existingRate.box_delivery_marketplace_base, name: 'box_delivery_marketplace_base' },
            { processed: newRate.box_delivery_marketplace_coef, db: existingRate.box_delivery_marketplace_coef, name: 'box_delivery_marketplace_coef' },
            { processed: newRate.box_delivery_marketplace_liter, db: existingRate.box_delivery_marketplace_liter, name: 'box_delivery_marketplace_liter' },
            { processed: newRate.box_storage_base, db: existingRate.box_storage_base, name: 'box_storage_base' },
            { processed: newRate.box_storage_coef, db: existingRate.box_storage_coef, name: 'box_storage_coef' },
            { processed: newRate.box_storage_liter, db: existingRate.box_storage_liter, name: 'box_storage_liter' }
        ];

        for (const field of fieldsToCompare) {
            if (Math.abs(field.processed - field.db) > 0.01) { // Точность до 2 знаков
                this.logger.info(`Rate mismatch for warehouse ${warehouseId}: ${field.name} processed=${field.processed}, DB=${field.db} - rates don't match`);
                return false;
            }
        }

        this.logger.info(`Rates match for period ${periodId} and warehouse ${warehouseId}`);
        return true;
    }

    private async processWarehouses(processedData: ProcessedData, trx: any): Promise<void> {
        this.logger.info(`Processing ${processedData.warehouses.length} warehouses`);

        for (let i = 0; i < processedData.warehouses.length; i++) {
            const warehouse = processedData.warehouses[i];
            
            // Проверяем существование склада
            let existingWarehouse = await trx('warehouses')
                .where('geo_name', warehouse.geo_name)
                .where('warehouse_name', warehouse.warehouse_name)
                .first();

            if (!existingWarehouse) {
                // Создаем новый склад
                const [newWarehouse] = await trx('warehouses')
                    .insert({
                        geo_name: warehouse.geo_name,
                        warehouse_name: warehouse.warehouse_name
                    })
                    .returning('*');
                
                existingWarehouse = newWarehouse;
                this.logger.info(`Created new warehouse: ${warehouse.geo_name} - ${warehouse.warehouse_name}`);
            }

            // Заполняем ID в processedData
            warehouse.id = existingWarehouse.id;
        }
    }

    private async saveBoxRates(processedData: ProcessedData, trx: any): Promise<void> {
        this.logger.info(`Saving box rates for ${processedData.boxRates.length} warehouses`);

        for (let i = 0; i < processedData.boxRates.length; i++) {
            const boxRate = processedData.boxRates[i];

            if (!boxRate.warehouse_id || !boxRate.tariff_period_id) {
                this.logger.warn(`Missing IDs for warehouse or tariff period at index ${i}`);
                continue;
            }

            const boxRateData = {
                warehouse_id: boxRate.warehouse_id,
                tariff_period_id: boxRate.tariff_period_id,
                box_delivery_base: boxRate.box_delivery_base,
                box_delivery_coef: boxRate.box_delivery_coef,
                box_delivery_liter: boxRate.box_delivery_liter,
                box_delivery_marketplace_base: boxRate.box_delivery_marketplace_base,
                box_delivery_marketplace_coef: boxRate.box_delivery_marketplace_coef,
                box_delivery_marketplace_liter: boxRate.box_delivery_marketplace_liter,
                box_storage_base: boxRate.box_storage_base,
                box_storage_coef: boxRate.box_storage_coef,
                box_storage_liter: boxRate.box_storage_liter
            };

            const [savedBoxRate] = await trx('box_rates')
                .insert(boxRateData)
                .onConflict(['warehouse_id', 'tariff_period_id'])
                .merge()
                .returning('*');

            // Заполняем ID в processedData
            boxRate.id = savedBoxRate.id;
        }
    }
}

/**
 * Результат обработки данных
 */
export interface ProcessResult {
    tariffPeriodsCount: number;
    warehousesCount: number;
    boxRatesCount: number;
}

/**
 * Типы обработанных данных
 */
export interface ProcessedData {
    warehouses: ProcessedWarehouse[];
    boxRates: ProcessedBoxRate[];
    tariffPeriodEndDate: Date;
}

export interface ProcessedWarehouse {
    id?: string;
    geo_name: string;
    warehouse_name: string;
}

export interface ProcessedBoxRate {
    id?: string;
    warehouse_id?: string;
    tariff_period_id?: string;

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