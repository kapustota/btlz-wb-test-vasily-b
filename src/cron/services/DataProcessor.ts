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
                
                // Обрабатываем тарифный период и получаем информацию о том, нужны ли новые тарифы
                const needsNewRates = await this.processTariffPeriod(processedData, trx);
                
                // Обрабатываем склады и заполняем их ID
                await this.processWarehouses(processedData, trx);
                
                // Обрабатываем тарифы только если нужны новые
                if (needsNewRates) {
                    await this.processBoxRates(processedData, trx);
                }

                this.logger.info(`Successfully processed: 1 tariff period, ${processedData.warehouses.length} warehouses, ${needsNewRates ? processedData.boxRates.length : 0} box rates`);
                
                return {
                    tariffPeriodsCount: 1,
                    warehousesCount: processedData.warehouses.length,
                    boxRatesCount: needsNewRates ? processedData.boxRates.length : 0
                };

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
            tariffPeriod: {
                start_date: new Date(),
                end_date: new Date(wbData.dtTillMax)
            }
        };
    }

    private async processTariffPeriod(processedData: ProcessedData, trx: any): Promise<boolean> {
        this.logger.info(`Processing tariff period with end date: ${processedData.tariffPeriod.end_date?.toISOString()}`);
        
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const currentPeriod = await trx('tariff_periods')
            .where('start_date', '<=', today)
            .where(function(this: any) {
                this.whereNull('end_date').orWhere('end_date', '>=', today);
            })
            .first();

        if (currentPeriod) {
            const ratesMatch = await this.checkRatesMatch(currentPeriod.id, processedData, trx);
            
            if (ratesMatch) {
                // Тарифы совпадают - просто обновляем end_date, новые тарифы не нужны
                await trx('tariff_periods')
                    .where('id', currentPeriod.id)
                    .update({ end_date: processedData.tariffPeriod.end_date });
                
                processedData.tariffPeriod.id = currentPeriod.id;
                processedData.tariffPeriod.start_date = new Date(currentPeriod.start_date);
                
                this.logger.info(`Updated existing period ${currentPeriod.id} end date to ${processedData.tariffPeriod.end_date?.toISOString().split('T')[0]} - no new rates needed`);
                return false; // Новые тарифы не нужны
            } else {
                // Тарифы не совпадают - закрываем старый период и создаем новый
                await trx('tariff_periods')
                    .where('id', currentPeriod.id)
                    .update({ end_date: yesterday });
                
                const [newPeriod] = await trx('tariff_periods')
                    .insert({
                        start_date: today,
                        end_date: processedData.tariffPeriod.end_date
                    })
                    .returning('*');
                
                processedData.tariffPeriod.id = newPeriod.id;
                processedData.tariffPeriod.start_date = today;
                
                this.logger.info(`Closed period ${currentPeriod.id} at ${yesterday.toISOString().split('T')[0]}, created new period ${newPeriod.id} from ${today.toISOString().split('T')[0]} to ${processedData.tariffPeriod.end_date?.toISOString().split('T')[0]} - new rates needed`);
                return true; // Новые тарифы нужны
            }
        } else {
            // Нет текущего периода - создаем новый
            const [newPeriod] = await trx('tariff_periods')
                .insert({
                    start_date: today,
                    end_date: processedData.tariffPeriod.end_date
                })
                .returning('*');
            
            processedData.tariffPeriod.id = newPeriod.id;
            processedData.tariffPeriod.start_date = today;
            
            this.logger.info(`Created new period ${newPeriod.id} from ${today.toISOString().split('T')[0]} to ${processedData.tariffPeriod.end_date?.toISOString().split('T')[0]} - new rates needed`);
            return true; // Новые тарифы нужны
        }
    }

    private async checkRatesMatch(periodId: string, processedData: ProcessedData, trx: any): Promise<boolean> {
        this.logger.info(`Checking rates match for period ${periodId}`);
    
        const existingRates = await trx('box_rates')
            .join('warehouses', 'box_rates.warehouse_id', 'warehouses.id')
            .where('box_rates.tariff_period_id', periodId)
            .select(
                'warehouses.geo_name',
                'warehouses.warehouse_name',
                knex.raw('box_rates.box_delivery_base::float as box_delivery_base'),
                knex.raw('box_rates.box_delivery_coef::float as box_delivery_coef'),
                knex.raw('box_rates.box_delivery_liter::float as box_delivery_liter'),
                knex.raw('box_rates.box_delivery_marketplace_base::float as box_delivery_marketplace_base'),
                knex.raw('box_rates.box_delivery_marketplace_coef::float as box_delivery_marketplace_coef'),
                knex.raw('box_rates.box_delivery_marketplace_liter::float as box_delivery_marketplace_liter'),
                knex.raw('box_rates.box_storage_base::float as box_storage_base'),
                knex.raw('box_rates.box_storage_coef::float as box_storage_coef'),
                knex.raw('box_rates.box_storage_liter::float as box_storage_liter')
            );

        if (existingRates.length === 0) {
            this.logger.info(`No existing rates found for period ${periodId} - rates don't match`);
            return false;
        }

        if (existingRates.length !== processedData.boxRates.length) {
            this.logger.info(`Rate count mismatch: DB has ${existingRates.length}, processed has ${processedData.boxRates.length} - rates don't match`);
            return false;
        }

        for (let i = 0; i < processedData.boxRates.length; i++) {
            const processedRate = processedData.boxRates[i];
            const warehouse = processedData.warehouses[i];
            
            const existingRate = existingRates.find((rate: any) => 
                rate.geo_name === warehouse.geo_name && 
                rate.warehouse_name === warehouse.warehouse_name
            );

            if (!existingRate) {
                this.logger.info(`Warehouse ${warehouse.geo_name} - ${warehouse.warehouse_name} not found in existing rates - rates don't match`);
                return false;
            }

            // Сравниваем все числовые поля (с точностью до 2 знаков после запятой)
            const fieldsToCompare = [
                { processed: processedRate.box_delivery_base, db: existingRate.box_delivery_base, name: 'box_delivery_base' },
                { processed: processedRate.box_delivery_coef, db: existingRate.box_delivery_coef, name: 'box_delivery_coef' },
                { processed: processedRate.box_delivery_liter, db: existingRate.box_delivery_liter, name: 'box_delivery_liter' },
                { processed: processedRate.box_delivery_marketplace_base, db: existingRate.box_delivery_marketplace_base, name: 'box_delivery_marketplace_base' },
                { processed: processedRate.box_delivery_marketplace_coef, db: existingRate.box_delivery_marketplace_coef, name: 'box_delivery_marketplace_coef' },
                { processed: processedRate.box_delivery_marketplace_liter, db: existingRate.box_delivery_marketplace_liter, name: 'box_delivery_marketplace_liter' },
                { processed: processedRate.box_storage_base, db: existingRate.box_storage_base, name: 'box_storage_base' },
                { processed: processedRate.box_storage_coef, db: existingRate.box_storage_coef, name: 'box_storage_coef' },
                { processed: processedRate.box_storage_liter, db: existingRate.box_storage_liter, name: 'box_storage_liter' }
            ];

            for (const field of fieldsToCompare) {
                if (Math.abs(field.processed - field.db) > 0.01) { // Точность до 2 знаков
                    this.logger.info(`Rate mismatch for ${warehouse.geo_name} - ${warehouse.warehouse_name}: ${field.name} processed=${field.processed}, DB=${field.db} - rates don't match`);
                    return false;
                }
            }
        }

        this.logger.info(`All rates match for period ${periodId}`);
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

    private async processBoxRates(processedData: ProcessedData, trx: any): Promise<void> {
        this.logger.info(`Processing box rates for ${processedData.boxRates.length} warehouses`);

        for (let i = 0; i < processedData.boxRates.length; i++) {
            const boxRate = processedData.boxRates[i];
            const warehouse = processedData.warehouses[i];
            const tariffPeriod = processedData.tariffPeriod;

            if (!warehouse.id || !tariffPeriod.id) {
                this.logger.warn(`Missing IDs for warehouse or tariff period at index ${i}`);
                continue;
            }

            const boxRateData = {
                warehouse_id: warehouse.id,
                tariff_period_id: tariffPeriod.id,
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
            boxRate.warehouse_id = savedBoxRate.warehouse_id;
            boxRate.tariff_period_id = savedBoxRate.tariff_period_id;
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
    tariffPeriod: ProcessedTariffPeriod;
}

export interface ProcessedWarehouse {
    id?: string;
    geo_name: string;
    warehouse_name: string;
}

export interface ProcessedTariffPeriod {
    id?: string;
    start_date: Date;
    end_date: Date | null;
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