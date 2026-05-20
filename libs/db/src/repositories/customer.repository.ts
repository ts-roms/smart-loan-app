import type {
  Customer,
  EmploymentStatus,
  GovernmentIdType,
  PrismaClient,
} from '@prisma/client';

export interface CustomerCreateInput {
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth: Date;
  phone: string;
  email?: string;
  address: string;
  city: string;
  province?: string;
  postalCode?: string;
  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;
  employmentStatus: EmploymentStatus;
  employerName?: string;
  jobTitle?: string;
  monthlyIncome: number;
  yearsAtCurrentJob?: number;
}

export type CustomerUpdateInput = Partial<CustomerCreateInput>;

export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<Customer[]> {
    return this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  create(input: CustomerCreateInput): Promise<Customer> {
    return this.prisma.customer.create({ data: input });
  }

  update(id: string, input: CustomerUpdateInput): Promise<Customer> {
    return this.prisma.customer.update({ where: { id }, data: input });
  }
}
