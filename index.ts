import * as pulumi from "@pulumi/pulumi";
import * as aws from '@pulumi/aws';
import * as cloud from '@pulumi/cloud-aws'

export { endpoint } from './api';

const tenMinutes = 60 * 10;

const stackConfig = new pulumi.Config('github-awesome-updater');

const config = {
  // pathToWebsiteContents is a relativepath to the website's contents.
  // pathToWebsiteContents: stackConfig.require("pathToWebsiteContents"),
  // targetDomain is the domain/host to serve content at.
  targetDomain: stackConfig.require("targetDomain"),
  // (Optional) ACM certificate ARN for the target domain; must be in the us-east-1 region. If omitted, an ACM certificate will be created.
  certificateArn: stackConfig.get("certificateArn"),
  profile: aws.config.profile,
};

// contentBucket is the S3 bucket that the website's contents will be stored in.
const contentBucket = new aws.s3.Bucket('contentBucket',
  {
    bucket: config.targetDomain,
    acl: 'public-read',
    // Configure S3 to serve bucket contents as a website. This way S3 will automatically convert
    // requests for "foo/" to "foo/index.html".
    website: {
      indexDocument: "index.html",
      errorDocument: "404.html",
    }
  });

// logsBucket is an S3 bucket that will contain the CDN's request logs.
const logsBucket = new aws.s3.Bucket("requestLogs", {
  bucket: `${config.targetDomain}-logs`,
  acl: "private",
});

let certificateArn: pulumi.Input<string> = config.certificateArn!;

const eastRegion = new aws.Provider("east", {
  profile: config.profile,
  region: "us-east-1", // Per AWS, ACM certificate must be in the us-east-1 region.
});

/**
 * Only provision a certificate (and related resources) if a certificateArn is _not_ provided via configuration.
 */
if (config.certificateArn === undefined) {
  const certificate = new aws.acm.Certificate("certificate", {
    domainName: config.targetDomain,
    validationMethod: 'DNS',
  }, { provider: eastRegion });

  const domainParts = getDomainAndSubdomain(config.targetDomain);
  const hostedZoneId = aws.route53.getZone({ name: domainParts.parentDomain }).then(zone => zone.id);

  /**
   *  Create a DNS record to prove that we _own_ the domain we're requesting a certificate for.
   *  See https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-validate-dns.html for more info.
   */
  const certificateValidationDomain = new aws.route53.Record(`${config.targetDomain}-validation`, {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    zoneId: hostedZoneId,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    ttl: tenMinutes,
  });

  /**
   * This is a _special_ resource that waits for ACM to complete validation via the DNS record
   * checking for a status of "ISSUED" on the certificate itself. No actual resources are
   * created (or updated or deleted).
   *
   * See https://www.terraform.io/docs/providers/aws/r/acm_certificate_validation.html for slightly more detail
   * and https://github.com/terraform-providers/terraform-provider-aws/blob/master/aws/resource_aws_acm_certificate_validation.go
   * for the actual implementation.
   */
  const certificateValidation = new aws.acm.CertificateValidation("certificateValidation", {
    certificateArn: certificate.arn,
    validationRecordFqdns: [certificateValidationDomain.fqdn],
  }, { provider: eastRegion });

  certificateArn = certificateValidation.certificateArn;

  certificateArn.apply(cert => console.log('cert', cert));
}

const funcRole = new aws.iam.Role('edge-lamda', {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Principal: {
          Service: [
            "lambda.amazonaws.com",
            "edgelambda.amazonaws.com",
          ],
        },
        Effect: "Allow",
        Sid: "",
      },
    ],
  }),
});

const func = new aws.lambda.CallbackFunction('badge-creator', {
  publish: true,
  timeout: 5,
  role: funcRole,
  callback: async (event: any, context) => {
    // {
    //   "method": "GET",
    //   "querystring": "",
    //   "uri": "/badge/foo"
    // }

    console.log('foo!');

    return {
      status: '200',
      headers: {
        'content-encoding': [{ value: 'utf-8' }],
        'content-type': [{ value: 'image/svg+xml;charset=utf-8' }],
      },
      body: '',
    };
  },
}, { provider: eastRegion })

const cacheBehavior = {
  targetOriginId: contentBucket.arn,
  pathPattern: "/badge/*",
  allowedMethods: ["GET", "HEAD",],
  cachedMethods: ["GET", "HEAD",],
  forwardedValues: {
    cookies: { forward: "none" },
    queryString: false,
  },
  // lambdaFunctionAssociations: [{
  //   eventType: "viewer-request",
  //   includeBody: false,
  //   lambdaArn: pulumi.all([func.arn, func.version]).apply(([arn, version]) => `${arn}:${version}`),
  // }],
  viewerProtocolPolicy: "allow-all",
};

// distributionArgs configures the CloudFront distribution. Relevant documentation:
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html
// https://www.terraform.io/docs/providers/aws/r/cloudfront_distribution.html
const distributionArgs: aws.cloudfront.DistributionArgs = {
  enabled: true,
  // Alternate aliases the CloudFront distribution can be reached at, in addition to https://xxxx.cloudfront.net.
  // Required if you want to access the distribution via config.targetDomain as well.
  aliases: [config.targetDomain],

  // We only specify one origin for this distribution, the S3 content bucket.
  origins: [
    {
      originId: contentBucket.arn,
      domainName: contentBucket.websiteEndpoint,
      customOriginConfig: {
        // Amazon S3 doesn't support HTTPS connections when using an S3 bucket configured as a website endpoint.
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginProtocolPolicy
        originProtocolPolicy: "http-only",
        httpPort: 80,
        httpsPort: 443,
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],

  defaultRootObject: "index.html",

  // A CloudFront distribution can configure different cache behaviors based on the request path.
  // Here we just specify a single, default cache behavior which is just read-only requests to S3.
  defaultCacheBehavior: {
    targetOriginId: contentBucket.arn,

    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    cachedMethods: ["GET", "HEAD", "OPTIONS"],

    forwardedValues: {
      cookies: { forward: "none" },
      queryString: false,
    },

    minTtl: 0,
    defaultTtl: tenMinutes,
    maxTtl: tenMinutes,
  },

  orderedCacheBehaviors: [cacheBehavior],

  // "All" is the most broad distribution, and also the most expensive.
  // "100" is the least broad, and also the least expensive.
  priceClass: "PriceClass_100",

  // You can customize error responses. When CloudFront recieves an error from the origin (e.g. S3 or some other
  // web service) it can return a different error code, and return the response for a different resource.
  customErrorResponses: [
    { errorCode: 404, responseCode: 404, responsePagePath: "/404.html" },
  ],

  restrictions: {
    geoRestriction: {
      restrictionType: "none",
    },
  },

  viewerCertificate: {
    acmCertificateArn: certificateArn,  // Per AWS, ACM certificate must be in the us-east-1 region.
    sslSupportMethod: "sni-only",
  },

  loggingConfig: {
    bucket: logsBucket.bucketDomainName,
    includeCookies: false,
    prefix: `${config.targetDomain}/`,
  },
};

const cdn = new aws.cloudfront.Distribution("cdn", distributionArgs);

// Split a domain name into its subdomain and parent domain names.
// e.g. "www.example.com" => "www", "example.com".
function getDomainAndSubdomain(domain: string): { subdomain: string, parentDomain: string } {
  const parts = domain.split(".");
  if (parts.length < 2) {
    throw new Error(`No TLD found on ${domain}`);
  }
  // No subdomain, e.g. awesome-website.com.
  if (parts.length === 2) {
    return { subdomain: "", parentDomain: domain };
  }

  const subdomain = parts[0];
  parts.shift();  // Drop first element.
  return {
    subdomain,
    // Trailing "." to canonicalize domain.
    parentDomain: parts.join(".") + ".",
  };
}

// Creates a new Route53 DNS record pointing the domain to the CloudFront distribution.
async function createAliasRecord(
  targetDomain: string, distribution: aws.cloudfront.Distribution): Promise<aws.route53.Record> {
  const domainParts = getDomainAndSubdomain(targetDomain);
  const hostedZone = await aws.route53.getZone({ name: domainParts.parentDomain });
  return new aws.route53.Record(
    targetDomain,
    {
      name: domainParts.subdomain,
      zoneId: hostedZone.zoneId,
      type: "A",
      aliases: [
        {
          name: distribution.domainName,
          zoneId: distribution.hostedZoneId,
          evaluateTargetHealth: true,
        },
      ],
    });
}

const aRecord = createAliasRecord(config.targetDomain, cdn);

// Export properties from this stack. This prints them at the end of `pulumi up` and
// makes them easier to access from the pulumi.com.
export const contentBucketUri = pulumi.interpolate`s3://${contentBucket.bucket}`;
export const contentBucketWebsiteEndpoint = contentBucket.websiteEndpoint;
export const cloudFrontDomain = cdn.domainName;
export const targetDomainEndpoint = `https://${config.targetDomain}/`;