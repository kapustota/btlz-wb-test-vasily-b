import { syncRates } from "#cron/syncRates.js";
import knex, { migrate, seed } from "#postgres/knex.js";
import cron from "node-cron";
import { Logger } from "#cron/utils/Logger.js";

const logger = new Logger("App");

try {
    logger.info("Running database migrations...");
    await migrate.latest();
    logger.info("Database migrations completed");

    logger.info("Running database seeds...");
    await seed.run();
    logger.info("Database seeds completed");

    const cronSchedule = "0 * * * *";
    logger.info(`Setting up cron job with schedule: ${cronSchedule} (daily at midnight)`);
    
    cron.schedule(cronSchedule, async () => {
        logger.info("Cron job triggered: Starting rates synchronization...");
        try {
            await syncRates();
            logger.info("Cron job completed successfully");
        } catch (error) {
            logger.error("Cron job failed:", error);
        }
    }, {
        scheduled: true,
        timezone: "Europe/Moscow"
    });

    logger.info("Application started successfully");
    logger.info("Cron job is scheduled to run daily at midnight (Moscow time)");
    
} catch (error) {
    logger.error("Failed to start application:", error);
    process.exit(1);
}