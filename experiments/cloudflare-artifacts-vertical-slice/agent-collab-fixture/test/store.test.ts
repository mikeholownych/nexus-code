import { readCustomer } from "../src/customer-store";

const customer = readCustomer("cust-1");
if (customer.id !== "cust-1" || customer.name !== "Ada") {
	throw new Error("Store contract check failed");
}
