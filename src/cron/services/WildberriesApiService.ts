import { Logger } from "../utils/Logger.js";

/**
 * Сервис для работы с Wildberries API
 */
export class WildberriesApiService {
    private readonly token: string;
    private readonly logger: Logger;
    private readonly baseUrl = "https://common-api.wildberries.ru";

    constructor(token: string) {
        this.token = token;
        this.logger = new Logger("WildberriesApiService");
    }

    /**
     * Получение тарифов коробов для складов
     */
    async getWarehouseBoxRates(): Promise<WbWarehouseBoxRatesResponse> {
        this.logger.info("Fetching warehouse box rates from Wildberries API");

        const NODE_ENV = process.env.NODE_ENV ?? "development";
        
        if (NODE_ENV === "development") {
            this.logger.warn("Using mock data - set NODE_ENV=production for live API");
            return this.getMockData();
        }

        try {
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const url = `${this.baseUrl}/api/v1/tariffs/box?date=${today}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (!response.ok) {
                throw new Error(`WB API error: ${response.status} ${response.statusText}`);
            }

            const responseData = await response.json();
            const data = responseData.response.data as WbWarehouseBoxRatesResponse;
            this.logger.info(`Received ${data.warehouseList?.length || 0} warehouses from WB API`);
            return data;

        } catch (error) {
            this.logger.error("Error fetching data from Wildberries API:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to fetch data from Wildberries API: ${errorMessage}`);
        }
    }

    /**
     * Заглушка с моковыми данными (для разработки)
     */
    private getMockData(): WbWarehouseBoxRatesResponse {
        return {
            dtNextBox: "2025-10-01",
            dtTillMax: "2025-09-30",
            warehouseList: [
                {
                    boxDeliveryBase: "100.50",
                    boxDeliveryCoefExpr: "1.2",
                    boxDeliveryLiter: "15.75",
                    boxDeliveryMarketplaceBase: "120.00",
                    boxDeliveryMarketplaceCoefExpr: "1.3",
                    boxDeliveryMarketplaceLiter: "18.50",
                    boxStorageBase: "5.25",
                    boxStorageCoefExpr: "1.1",
                    boxStorageLiter: "2.75",
                    geoName: "Москва",
                    warehouseName: "Коледино"
                },
                {
                    boxDeliveryBase: "95.00",
                    boxDeliveryCoefExpr: "1.15",
                    boxDeliveryLiter: "14.25",
                    boxDeliveryMarketplaceBase: "115.50",
                    boxDeliveryMarketplaceCoefExpr: "1.25",
                    boxDeliveryMarketplaceLiter: "17.00",
                    boxStorageBase: "4.75",
                    boxStorageCoefExpr: "1.05",
                    boxStorageLiter: "2.50",
                    geoName: "Санкт-Петербург",
                    warehouseName: "Шушары"
                }
            ]
        };
    }
}

/**
 * Типы данных от Wildberries API
 */
export interface WbWarehouseBoxRatesResponse {
    dtNextBox: string;           // Дата начала следующего тарифа
    dtTillMax: string;           // Дата окончания последнего установленного тарифа
    warehouseList: WbWarehouseBoxRate[];
}

export interface WbWarehouseBoxRate {
    boxDeliveryBase: string;                    // Логистика, первый литр, ₽
    boxDeliveryCoefExpr: string;               // Коэффициент Логистика, %
    boxDeliveryLiter: string;                  // Логистика, дополнительный литр, ₽
    boxDeliveryMarketplaceBase: string;        // Логистика FBS, первый литр, ₽
    boxDeliveryMarketplaceCoefExpr: string;    // Коэффициент FBS, %
    boxDeliveryMarketplaceLiter: string;       // Логистика FBS, дополнительный литр, ₽
    boxStorageBase: string;                    // Хранение в день, первый литр, ₽
    boxStorageCoefExpr: string;                // Коэффициент Хранение, %
    boxStorageLiter: string;                   // Хранение в день, дополнительный литр, ₽
    geoName: string;                           // Страна, для РФ — округ
    warehouseName: string;                     // Название склада
}