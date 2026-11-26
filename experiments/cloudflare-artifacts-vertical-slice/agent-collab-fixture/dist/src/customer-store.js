"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readCustomer = readCustomer;
function readCustomer(id) {
    if (id !== "cust-1")
        throw new Error("Customer not found");
    return { id, name: "Ada" };
}
