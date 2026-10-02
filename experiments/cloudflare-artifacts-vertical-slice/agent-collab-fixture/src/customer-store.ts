export interface Customer {
	id: string;
	name: string;
}

export function readCustomer(id: string): Customer {
	if (id !== "cust-1") throw new Error("Customer not found");
	return { id, name: "Ada" };
}
