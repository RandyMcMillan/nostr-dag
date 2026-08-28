import 'reflect-metadata';
import type { TransportCertificate } from '../../index.ts';
export interface GenerateTransportCertificateOptions {
    days: number;
    start?: Date;
    extensions?: any[];
}
export declare function generateTransportCertificate(keyPair: CryptoKeyPair, options: GenerateTransportCertificateOptions): Promise<TransportCertificate>;
//# sourceMappingURL=generate-certificates.d.ts.map