Hi, I'm Ross. I'm a product engineer in the batch exports team here at Post Hog. And in this video, I'm going to show you how we use error tracking to find and fix errors as quickly as possible. So, before we get started, I'm going to show you how we've set up error tracking inside the [music] batch exports product.

So, let's go over to our editor. In batch exports, we're using a framework called Temporal, which is a workflow execution framework ideal for running batch processing jobs such as batch exports. We're also using the Python [music] SDK for Post Hog. And you can see here that [music] when executing each activity, we're wrapping that in a try except and we're calling the post hog capture exception function [music] which will record that error in error tracking.

What we're also doing here is we're passing it a set of properties. [music] These properties will enrich the error with any context that [music] might be useful for searching or debugging the error. So you can see here [music] we're setting various temporal properties and we're also adding the inputs of the activity as [music] well.

So let's jump back into error tracking and we can see how those are being used. So if we go into post hog [music] in our error tracking um let's first go into configure and we can see that we've set some auto assignment rules here. Scroll down we can see there's one for uh the batch exports team here and what we're doing here is we're going to assign any errors if these filters match and we're filtering based on a couple of those properties that we saw in our code.

So if the um temple task Q matches one of these expected [music] values, then we're going to assign that error to the batch Xbox team. And what that means is if we go back into the dashboard, we can filter our dashboard for to show only errors that [music] are relevant to our team.

Um, what I'm also going to do here is just filter on another property cuz at the moment we're showing all errors across all environments. [music] So we could for example search for temporal namespace [music] and if we set that to one of our production environments then we can see immediately only the issues that are affecting [music] those particular environments.

So we can see here at the top [music] we've got this click house error which is occurring pretty frequently. So let's dig into [music] this one and see if we can find what's going on. So we can see here at the top that we're having an issue where the value [music] none is being passed into a query when we're expecting a datetime value.

So we can have a look at the stack trace here and [music] we can see that this is happening in the HTTP batch export on line 261. So, if I just copy this, we can jump back into our editor and look up that file, go to line 261. [music] And we can see here that we're yeah, iterating over some records from Clickhouse.

[music] Let's see where those originate from. Okay. And we can see the interval start. Yeah, it could be a string or none. We're obviously passing in none in this in this case. Um, let's see where that could be causing an issue. So, we've got different queries here built from different templates. Let's see if we can find some more context in the error itself to find out [music] what could be going wrong.

Let's jump back into error tracking [music] and we can go over to this properties tab. And here we've got some of those custom properties that we were setting in our error. Let's see if any of these look helpful. [music] Okay, we can see here actually that we've got the batch export model here set to the persons model.

Um, so in batch exports, you [music] can export either events, persons or sessions. And I know for a fact that for the HTTP batch exports, [music] we only expect um events model to be used. That's why we see here that [music] we're only expecting uh queries that use the events table. So I think what's happening here is that [music] um someone has created a HTTP batch export for the person's model and we're not handling that correctly in our code.

So next steps [music] here would be to add a check for that higher up the stack. So possibly in the front end [music] and probably additionally at the API layer to ensure that for HTTP batch exports uh only the event model is permitted. So yeah, that's the end of this uh demo. Well, I hope that quick example helped demonstrate how we use error tracking [music] at Post Hog to quickly identify and resolve any errors that you might have in your product.

Thanks for watching. [music]
