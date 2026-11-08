const fs = require('fs');
let content = fs.readFileSync('src/lib/api.ts', 'utf8');

content = content.replace(
  "getSalesHistory: (start_date?: string, end_date?: string, customer_id?: number) => {",
  `getFullSalesHistory: (start_date?: string, end_date?: string, customer_id?: number) => {
    const query = new URLSearchParams();
    if (start_date) query.append('start_date', start_date);
    if (end_date) query.append('end_date', end_date);
    if (customer_id) query.append('customer_id', String(customer_id));
    query.append('include_items', 'true');
    return request<SaleHeader[]>(\`/sales/history?\${query.toString()}\`);
  },
  getSalesHistory: (start_date?: string, end_date?: string, customer_id?: number) => {`
);

fs.writeFileSync('src/lib/api.ts', content);
