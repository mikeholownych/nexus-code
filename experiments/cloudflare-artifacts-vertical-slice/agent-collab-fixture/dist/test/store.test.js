"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const customer_store_1 = require("../src/customer-store");
const customer = (0, customer_store_1.readCustomer)("cust-1");
if (customer.id !== "cust-1" || customer.name !== "Ada") {
    throw new Error("Store contract check failed");
}
