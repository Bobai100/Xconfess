import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchDiscoveryService } from './search-discovery.service';
import { SearchDiscoveryController } from './search-discovery.controller';
import { SavedSearch } from './entities/saved-search.entity';
import { SearchHistory } from './entities/search-history.entity';
import { UserDiscoveryPreference } from './entities/user-discovery-preference.entity';
import { SearchIndexOutbox } from './entities/search-index-outbox.entity';
import { SearchIndexOutboxService } from './search-index-outbox.service';
import { SearchAbuseGuard } from './search-abuse.guard';
import { UserModule } from '../user/user.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SavedSearch,
      SearchHistory,
      UserDiscoveryPreference,
      SearchIndexOutbox,
    ]),
    UserModule,
    FeatureFlagsModule,
  ],
  providers: [
    SearchDiscoveryService,
    SearchAbuseGuard,
    SearchIndexOutboxService,
  ],
  controllers: [SearchDiscoveryController],
  exports: [
    SearchDiscoveryService,
    SearchAbuseGuard,
    SearchIndexOutboxService,
  ],
})
export class SearchDiscoveryModule {}