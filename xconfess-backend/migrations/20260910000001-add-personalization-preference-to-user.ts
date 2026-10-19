import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPersonalizationPreferenceToUser20260910000001
  implements MigrationInterface
{
  name = 'AddPersonalizationPreferenceToUser20260910000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await queryRunner.getTable('users');

    if (!usersTable) {
      throw new Error(
        'Migration AddPersonalizationPreferenceToUser failed: "users" table does not exist',
      );
    }

    const existingColumn = usersTable.findColumnByName('personalizationEnabled');

    if (existingColumn) {
      return;
    }

    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'personalizationEnabled',
        type: 'boolean',
        isNullable: false,
        default: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await queryRunner.getTable('users');

    if (!usersTable) {
      return;
    }

    const existingColumn = usersTable.findColumnByName('personalizationEnabled');

    if (!existingColumn) {
      return;
    }

    await queryRunner.dropColumn('users', 'personalizationEnabled');
  }
}