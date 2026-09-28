export const PREPARE_SQL = `CREATE TABLE IF NOT EXISTS opfs_demo_sales_v1 AS
SELECT i AS event_id,
       DATE '2025-01-01' + (i % 365)::INTEGER AS event_date,
       ((i * 7) % 8)::UTINYINT AS region,
       ((i * 3) % 4)::UTINYINT AS channel,
       ((i * 13) % 10000)::INTEGER AS product_id,
       ((i * 31) % 100000)::INTEGER AS customer_id,
       (1 + i % 5)::INTEGER AS quantity,
       (100 + (i * 7919) % 100000)::INTEGER AS revenue_cents,
       (200 + i % 800)::INTEGER AS shipping_cents,
       i % 17 = 0 AS returned
FROM range(1000000) AS t(i);`;

export const SUM_SQL = `SELECT sum(revenue_cents) AS total_revenue_cents
FROM opfs_demo_sales_v1;`;

export const GROUP_SQL = `SELECT region,
       sum(revenue_cents) AS revenue_cents
FROM opfs_demo_sales_v1
GROUP BY region
ORDER BY revenue_cents DESC;`;
